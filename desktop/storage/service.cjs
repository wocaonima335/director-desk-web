// DSK-004: storage session/transfer/lease orchestration and the real DSK action handlers.
// Implements the approved surface: project.list/status/create/open, storage.v1.project.list/close,
// storage.v1.session.bootstrap/activate/leave, upload.begin/chunk/commit, transfer.abort,
// snapshot.read/download.chunk and backup.create/restore. Sessions and transfers are bound to the
// trusted sender frame; the renderer never receives or supplies filesystem paths.
// Rework-1 hardening: transfer slots are reserved synchronously before any await and every
// transfer operation runs through a per-transfer serial queue that re-checks cancellation and
// ordering at execution time (R7); base64 is decoded and re-encoded to reject non-canonical
// input (R7); backups/restores stream objects with streaming hash verification and enforce size
// budgets before reading (R8); restore validates the full snapshot/object closure and hidden
// rows before registering anything (R3); lease renewal failures degrade the lease in a controlled
// way instead of throwing inside a timer, and isBusy counts in-flight operations, not just
// transfers (R10). Initialization failures must not block app startup, so
// createUnavailableStorageService provides a diagnostic-only fallback.
// Node-only module: Electron imports stay in integration.cjs; verification, canonicalization and
// the backup-manifest schema are injected (they live in DOM-free TS modules bundled by esbuild).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createObjectStore } = require('./objects.cjs');
const { openLibrary, inspectBackupDatabase, createBackupDatabase } = require('./library.cjs');
const {
    STORAGE_MAX_PROJECT_BYTES, STORAGE_CHUNK_BYTES, STORAGE_UPLOAD_IDLE_MS, STORAGE_TRANSFER_TOTAL_MS,
    STORAGE_MAX_TRANSFERS_PER_FRAME, STORAGE_BACKUP_MAX_SNAPSHOTS, STORAGE_BACKUP_MAX_BYTES,
    STORAGE_RESULT_SCHEMAS, PIPELINE_STORAGE_RESULT_SCHEMAS, storageFailure, scanStorageProject,
    isStorageFailureReason,
} = require('../../shared/contracts/storage.ts');

const UPLOADS_DIR = 'uploads';
const HOST_MAX_TRANSFERS = 16;
const MANIFEST_MAX_BYTES = 1024 * 1024; // R8: bounded manifest read

function fail(reason, detail) {
    return storageFailure(reason, detail);
}

function resultSchema(action) {
    return STORAGE_RESULT_SCHEMAS[action] ?? PIPELINE_STORAGE_RESULT_SCHEMAS[action];
}

function ok(action, data) {
    const schema = resultSchema(action);
    if (!schema) return fail('storage-unavailable', '存储动作没有已冻结的结果契约');
    const check = schema.safeParse(data);
    if (!check.success) return fail('storage-unavailable', '存储操作返回结果未通过契约校验');
    return { ok: true, data: check.data };
}

function toSummary(project) {
    return { projectId: project.projectId, name: project.name, revision: project.revision, current: project.current, updatedAt: project.updatedAt };
}

function projectErrorToFailure(error) {
    const reason = error && isStorageFailureReason(String(error.reason)) ? error.reason : 'storage-unavailable';
    return fail(reason, error && error.message ? error.message : '存储操作失败');
}

/** R7: strict canonical base64 — charset/padding by regex, then decode and re-encode equality. */
function strictBase64Decode(text) {
    if (typeof text !== 'string' || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
        || (text.includes('=') && text.indexOf('=') < text.length - 2)) {
        throw Error('不是规范 base64');
    }
    const buffer = Buffer.from(text, 'base64');
    if (buffer.toString('base64') !== text) throw Error('base64 编码不规范');
    return buffer;
}

/** Fallback service used when the library cannot be opened: every action answers with the frozen
 * failure shape (carrying the diagnosis in the detail) so the renderer can query and report it
 * instead of the main process crashing during attachIntegration. */
function createUnavailableStorageService(detail) {
    const failure = fail('storage-unavailable', `项目库不可用：${String(detail).slice(0, 160)}`);
    const handlers = {};
    for (const action of [
        'project.list', 'project.status', 'project.open', 'project.create',
        'storage.v1.project.list', 'storage.v1.project.close',
        'storage.v1.session.bootstrap', 'storage.v1.session.activate', 'storage.v1.session.leave',
        'storage.v1.upload.begin', 'storage.v1.upload.chunk', 'storage.v1.upload.commit',
        'storage.v1.transfer.abort', 'storage.v1.snapshot.read', 'storage.v1.snapshot.download.chunk',
        'storage.v1.backup.create', 'storage.v1.backup.restore',
    ]) handlers[action] = async () => failure;
    return {
        handlers,
        isBusy: () => false,
        sessionCount: () => 0,
        closeFrameSessions() { },
        dispose() { },
        runInRequestContext: (_event, fn) => fn(),
        unavailable: true,
        _internal: null,
    };
}

/**
 * Create the storage service.
 * verifiers: { document: assertSceneDocument, canonical: canonicalJson, manifest: BackupManifestSchema }
 * dialog: Electron dialog module (backup/restore directory picking; never renderer-supplied paths).
 * root: managed library root directory (userData/managed in the product; isolated dir in tests).
 */
function createStorageService({ root, verifiers, dialog, now = () => Date.now(), randomUUID = () => crypto.randomUUID(),
    leaseTtlMs = 30000, leaseRenewMs = 10000, library, objects } = {}) {
    const requestContext = new AsyncLocalStorage();
    const store = objects ?? createObjectStore({ root });
    const db = library ?? openLibrary({ file: path.join(root, 'library.sqlite'), now });
    const sessions = new Map(); // sessionId -> session
    const transfers = new Map(); // transferId -> transfer
    let pendingOperations = 0; // R10: in-flight handler operations (incl. dialog waits)
    let disposed = false;

    const sweeper = setInterval(() => sweepTransfers(), Math.min(15000, Math.max(1000, Math.floor(STORAGE_UPLOAD_IDLE_MS / 4))));
    sweeper.unref?.();

    function sweepTransfers() {
        const at = now();
        for (const transfer of [...transfers.values()]) {
            const idle = at - transfer.lastActivity > STORAGE_UPLOAD_IDLE_MS;
            const total = at - transfer.startedAt > STORAGE_TRANSFER_TOTAL_MS;
            if (idle || total) void cancelTransfer(transfer, 'timeout');
        }
    }

    function currentEvent() { return requestContext.getStore() ?? null; }

    function requireSession(sessionId) {
        if (disposed) throw Object.assign(Error('存储服务已停止'), { reason: 'storage-unavailable' });
        const session = sessions.get(sessionId);
        if (!session) throw Object.assign(Error('存储会话不存在或已关闭'), { reason: 'unknown-session' });
        const event = currentEvent();
        if (!event || event.sender !== session.sender || event.senderFrame !== session.frame) {
            throw Object.assign(Error('存储会话与当前页面帧不匹配'), { reason: 'frame-mismatch' });
        }
        return session;
    }

    function frameTransferCounts(event) {
        let uploads = 0, downloads = 0;
        for (const transfer of transfers.values()) {
            if (!transfer.event || !event || transfer.event.sender !== event.sender || transfer.event.senderFrame !== event.senderFrame) continue;
            if (transfer.kind === 'upload') uploads += 1; else downloads += 1;
        }
        return { uploads, downloads };
    }

    async function cancelTransfer(transfer, reason) {
        if (!transfers.has(transfer.transferId)) return;
        transfer.cancelled = reason; // R7: queued operations observe this before touching state
        transfers.delete(transfer.transferId);
        const session = sessions.get(transfer.sessionId);
        if (session) {
            if (transfer.kind === 'upload') session.uploadTransferId = undefined;
            else session.downloadTransferId = undefined;
        }
        if (transfer.kind === 'upload') {
            try { await transfer.handle?.close(); } catch { /* already closed */ }
            try { await fsp.rm(transfer.tmpPath, { force: true }); } catch { /* best effort */ }
        }
        transfer.aborted = reason;
    }

    /** R7: serialize every mutation of one transfer; each operation re-checks liveness/ordering
     * at its actual execution time, so late chunks or commits cannot land after cancellation. */
    function enqueueTransferOperation(transfer, operation) {
        const run = async () => {
            if (transfer.cancelled || !transfers.has(transfer.transferId)) {
                return fail('unknown-transfer', '传输已取消或结束，操作被拒绝');
            }
            return await operation();
        };
        const next = (transfer.queue ?? Promise.resolve()).then(run, run);
        transfer.queue = next.catch(() => { }); // keep the chain alive for subsequent operations
        return next;
    }

    // --- Lease upkeep ---------------------------------------------------------------
    function ensureLease(session) {
        if (session.leaseOwned && session.lease) return session.lease;
        const result = db.acquireLease(session.projectId, leaseTtlMs);
        if (!result.acquired) return null;
        session.leaseOwned = true;
        session.leaseBusy = false;
        session.lease = { owner: result.owner, generation: result.generation };
        startRenewal(session);
        return session.lease;
    }

    function invalidateLease(session) {
        // R10: controlled degradation — the expired/superseded generation is never resurrected.
        session.leaseOwned = false;
        session.leaseBusy = true;
        session.lease = null;
    }

    function startRenewal(session) {
        if (session.renewTimer) return;
        session.renewTimer = setInterval(() => {
            if (disposed || !sessions.has(session.sessionId) || !session.lease) return;
            let renewed;
            try {
                renewed = db.renewLease(session.projectId, session.lease.owner, session.lease.generation, leaseTtlMs);
            } catch {
                // Renewal errors (locked database, io) must not escape a timer callback; the lease
                // degrades to not-owned and the next upload.begin re-acquires from scratch.
                invalidateLease(session);
                clearInterval(session.renewTimer);
                session.renewTimer = undefined;
                return;
            }
            if (!renewed || !renewed.renewed) {
                invalidateLease(session);
                clearInterval(session.renewTimer);
                session.renewTimer = undefined;
            }
        }, Math.max(1000, leaseRenewMs));
        session.renewTimer.unref?.();
    }

    function stopRenewal(session) {
        if (session.renewTimer) { clearInterval(session.renewTimer); session.renewTimer = undefined; }
    }

    function closeSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return false;
        sessions.delete(sessionId);
        stopRenewal(session);
        for (const transfer of [...transfers.values()]) {
            if (transfer.sessionId === sessionId) void cancelTransfer(transfer, 'session-closed');
        }
        if (session.leaseOwned && session.lease) {
            try { db.releaseLease(session.projectId, session.lease.owner, session.lease.generation); } catch { /* best effort */ }
        }
        return true;
    }

    function closeFrameSessions() {
        for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
    }

    // --- Pipeline actions (DSK-003 surface, now real) -------------------------------
    function openSessionFor(project, event) {
        const session = {
            sessionId: randomUUID(), projectId: project.projectId, name: project.name,
            sender: event ? event.sender : null,
            frame: event ? event.senderFrame : null,
            revision: project.revision, current: project.current,
            leaseOwned: false, leaseBusy: false, lease: null,
            uploadTransferId: undefined, downloadTransferId: undefined,
            renewTimer: undefined, createdAt: now(),
        };
        sessions.set(session.sessionId, session);
        return session;
    }

    const rawHandlers = {
        'project.list': async () => ok('project.list', { projects: db.listProjects({ limit: 200 }).projects.map(toSummary) }),
        'project.create': async data => {
            const projectId = randomUUID();
            let created;
            try { created = db.createProject({ projectId, name: data.name }); }
            catch (error) { return projectErrorToFailure(error); }
            const event = currentEvent();
            const session = openSessionFor(created, event);
            let leaseOwned = false, leaseBusy = false;
            try {
                const lease = ensureLease(session);
                leaseOwned = !!lease; leaseBusy = !lease;
            } catch (error) {
                closeSession(session.sessionId);
                return projectErrorToFailure(error);
            }
            return ok('project.create', {
                sessionId: session.sessionId, projectId, name: created.name, revision: 0,
                current: null, leaseOwned, leaseBusy,
            });
        },
        'project.open': async data => {
            let project;
            try { project = db.getProject(data.projectId); }
            catch (error) { return projectErrorToFailure(error); }
            if (!project) return fail('unknown-project', '项目不存在');
            const event = currentEvent();
            const session = openSessionFor(project, event);
            let leaseOwned = false, leaseBusy = false;
            try {
                const lease = ensureLease(session);
                leaseOwned = !!lease; leaseBusy = !lease;
            } catch (error) {
                closeSession(session.sessionId);
                return projectErrorToFailure(error);
            }
            return ok('project.open', {
                sessionId: session.sessionId, projectId: project.projectId, name: project.name,
                revision: project.revision, current: project.current, leaseOwned, leaseBusy,
            });
        },
        'project.status': async data => {
            let project;
            try { project = db.getProject(data.projectId); }
            catch (error) { return projectErrorToFailure(error); }
            if (!project) return fail('unknown-project', '项目不存在');
            let integrity;
            try {
                integrity = await store.verifyProject(project.projectId, db.listSnapshots(project.projectId));
            } catch (error) { return projectErrorToFailure(error); }
            const lease = db.leaseState(project.projectId);
            const event = currentEvent();
            const ownSession = event ? [...sessions.values()].find(s => s.projectId === project.projectId
                && s.sender === event.sender && s.frame === event.senderFrame && s.leaseOwned && s.lease) : undefined;
            return ok('project.status', {
                projectId: project.projectId, name: project.name, revision: project.revision,
                current: project.current, updatedAt: project.updatedAt, integrity,
                lease: {
                    owned: !!(ownSession && lease.present && lease.generation === ownSession.lease.generation),
                    busy: lease.present && !lease.expired && !(ownSession && lease.generation === ownSession.lease.generation),
                    generation: lease.present ? lease.generation : undefined,
                },
            });
        },

        // --- storage.v1 session lifecycle ---------------------------------------------
        'storage.v1.session.bootstrap': async () => {
            const last = db.getlastSession();
            return ok('storage.v1.session.bootstrap', {
                mode: last ? last.mode : null,
                projectId: last ? last.projectId : null,
                name: last ? last.name : null,
            });
        },
        'storage.v1.session.activate': async data => {
            const session = requireSession(data.sessionId);
            db.setLastSession('managed', session.projectId, session.name);
            return ok('storage.v1.session.activate', { mode: 'managed', sessionId: session.sessionId, projectId: session.projectId });
        },
        'storage.v1.session.leave': async data => {
            const session = requireSession(data.sessionId);
            db.setLastSession('unmanaged', null, null);
            closeSession(session.sessionId);
            return ok('storage.v1.session.leave', { mode: 'unmanaged' });
        },
        'storage.v1.project.list': async data => {
            try {
                const page = db.listProjects({ cursor: data.cursor, limit: data.limit ?? 100 });
                return ok('storage.v1.project.list', { projects: page.projects.map(toSummary), nextCursor: page.nextCursor });
            } catch (error) { return projectErrorToFailure(error); }
        },
        'storage.v1.project.close': async data => {
            requireSession(data.sessionId);
            closeSession(data.sessionId);
            return ok('storage.v1.project.close', { closed: true });
        },

        // --- uploads -------------------------------------------------------------------
        'storage.v1.upload.begin': async data => {
            const session = requireSession(data.sessionId);
            // R7: every capacity/slot decision happens synchronously together with the slot
            // reservation, BEFORE the first await — concurrent begins cannot both slip through.
            if (session.uploadTransferId || session.downloadTransferId) {
                return fail('transfer-limit', '每个页面同时只能有一个进行中的工程传输');
            }
            if (transfers.size >= HOST_MAX_TRANSFERS) return fail('transfer-limit', '存储传输总数已达上限，请稍后重试');
            const counts = frameTransferCounts(currentEvent());
            if (counts.uploads >= STORAGE_MAX_TRANSFERS_PER_FRAME) return fail('transfer-limit', '已存在进行中的上传');
            let project;
            try { project = db.getProject(session.projectId); }
            catch (error) { return projectErrorToFailure(error); }
            if (!project) return fail('unknown-project', '项目不存在');
            if (Number(project.revision) !== Number(data.expectedRevision)) {
                return fail('revision-conflict', '项目已被其他保存更新，请刷新后重试');
            }
            let lease;
            try { lease = ensureLease(session); }
            catch (error) { return projectErrorToFailure(error); }
            if (!lease) return fail('lease-busy', '其他进程正在写入该项目，保存被拒绝');
            // Reserve the session + host slot now; the tmp file is opened after this point.
            const transferId = randomUUID();
            const tmpPath = path.join(root, UPLOADS_DIR, `${transferId}.part`);
            const transfer = {
                kind: 'upload', transferId, sessionId: session.sessionId, projectId: session.projectId,
                declaredLength: data.declaredLength, name: data.name, expectedRevision: Number(data.expectedRevision),
                received: 0, handle: null, tmpPath, startedAt: now(), lastActivity: now(), event: currentEvent(),
                queue: Promise.resolve(), cancelled: undefined,
            };
            transfers.set(transferId, transfer);
            session.uploadTransferId = transferId;
            try {
                await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
                transfer.handle = await fsp.open(tmpPath, 'wx');
            } catch {
                await cancelTransfer(transfer, 'tmp-open-failed');
                return fail('io-failure', '上传临时文件创建失败');
            }
            return ok('storage.v1.upload.begin', { transferId, declaredLength: data.declaredLength, chunkSize: STORAGE_CHUNK_BYTES });
        },
        'storage.v1.upload.chunk': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer || transfer.kind !== 'upload') return fail('unknown-transfer', '上传会话不存在或已结束');
            requireSession(transfer.sessionId);
            let chunk;
            try {
                chunk = strictBase64Decode(data.data); // R7: canonical decode or the chunk is refused
            } catch {
                await cancelTransfer(transfer, 'bad-base64');
                return fail('upload-format', '上传块不是有效的规范 base64，传输已取消');
            }
            if (chunk.length === 0 || chunk.length > STORAGE_CHUNK_BYTES) {
                await cancelTransfer(transfer, 'bad-size');
                return fail('upload-format', '上传块大小超出限制，传输已取消');
            }
            return enqueueTransferOperation(transfer, async () => {
                if (transfer.received !== data.offset) {
                    // R7: a duplicate/stale chunk (offset already covered) is rejected WITHOUT
                    // cancelling the transfer; only a forward gap breaks the stream.
                    if (data.offset < transfer.received) {
                        return fail('upload-format', '重复或迟到的上传块已被拒绝');
                    }
                    await cancelTransfer(transfer, 'bad-offset');
                    return fail('upload-format', '上传块顺序不正确，传输已取消');
                }
                if (transfer.received + chunk.length > transfer.declaredLength) {
                    await cancelTransfer(transfer, 'declared-length-exceeded');
                    return fail('upload-format', '上传总长度超过声明值，传输已取消');
                }
                try {
                    await transfer.handle.write(chunk);
                } catch {
                    await cancelTransfer(transfer, 'write-failed');
                    return fail('io-failure', '上传临时文件写入失败');
                }
                transfer.received += chunk.length;
                transfer.lastActivity = now();
                return ok('storage.v1.upload.chunk', { received: transfer.received });
            });
        },
        'storage.v1.upload.commit': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer || transfer.kind !== 'upload') return fail('unknown-transfer', '上传会话不存在或已结束');
            const session = requireSession(transfer.sessionId);
            return enqueueTransferOperation(transfer, async () => {
                if (transfer.cancelled || !sessions.has(session.sessionId)) {
                    return fail('unknown-transfer', '传输已取消或会话已关闭');
                }
                if (transfer.received !== transfer.declaredLength) {
                    await cancelTransfer(transfer, 'incomplete');
                    return fail('upload-format', '上传未完成，不能提交');
                }
                try { await transfer.handle.close(); } catch { /* tolerate double close */ }
                let bytes;
                try {
                    bytes = await fsp.readFile(transfer.tmpPath);
                } catch {
                    await cancelTransfer(transfer, 'tmp-read-failed');
                    return fail('io-failure', '上传临时文件读取失败');
                }
                if (bytes.length !== transfer.declaredLength) {
                    await cancelTransfer(transfer, 'length-mismatch');
                    return fail('upload-format', '上传内容长度与声明不符');
                }
                // Bounded parse + shared verifier + canonical serialization (main process is authoritative).
                let parsed;
                try { parsed = JSON.parse(bytes.toString('utf8')); }
                catch { await cancelTransfer(transfer, 'bad-json'); return fail('upload-format', '工程内容不是有效的 JSON'); }
                const scan = scanStorageProject(parsed);
                if (scan) { await cancelTransfer(transfer, 'scan-failed'); return fail('document-invalid', scan); }
                try { verifiers.document(parsed); }
                catch (error) { await cancelTransfer(transfer, 'invalid-document'); return fail('document-invalid', error instanceof Error ? error.message : '工程内容校验失败'); }
                let canonical;
                try { canonical = Buffer.from(verifiers.canonical(parsed), 'utf8'); }
                catch (error) { await cancelTransfer(transfer, 'canonical-failed'); return fail('document-invalid', error instanceof Error ? error.message : '工程规范化失败'); }
                // R8: canonical expansion is itself bounded by the same 64MiB budget.
                if (canonical.length > STORAGE_MAX_PROJECT_BYTES) {
                    await cancelTransfer(transfer, 'canonical-too-large');
                    return fail('document-invalid', '规范化工程超过 64 MiB 上限');
                }
                const digest = store.sha256Hex(canonical);
                const snapshotId = randomUUID();
                const createdAt = new Date(now()).toISOString();
                try {
                    await store.putObject(transfer.projectId, canonical);
                } catch (error) {
                    await cancelTransfer(transfer, 'object-write-failed');
                    return projectErrorToFailure(error);
                }
                try { await fsp.rm(transfer.tmpPath, { force: true }); } catch { /* best effort */ }
                transfers.delete(transfer.transferId);
                session.uploadTransferId = undefined;
                try {
                    db.commitSnapshot({
                        projectId: transfer.projectId,
                        owner: session.lease.owner,
                        generation: session.lease.generation,
                        expectedRevision: transfer.expectedRevision,
                        snapshot: { snapshotId, digest, length: canonical.length, createdAt },
                        now,
                    });
                } catch (error) {
                    // Object may be published while registration failed: it stays an untrusted orphan.
                    return projectErrorToFailure(error);
                }
                let project;
                try { project = db.getProject(transfer.projectId); }
                catch (error) { return projectErrorToFailure(error); }
                const revision = project ? Number(project.revision) : transfer.expectedRevision + 1;
                if (transfer.name && project && project.name !== transfer.name) {
                    try { db.renameProject(transfer.projectId, transfer.name); session.name = transfer.name; } catch { /* rename is best effort */ }
                }
                const snapshotRef = { version: 'dsk.v1', snapshotId, projectId: transfer.projectId, revision, digest, createdAt };
                session.revision = revision;
                session.current = snapshotRef;
                return ok('storage.v1.upload.commit', { snapshot: snapshotRef, revision });
            });
        },
        'storage.v1.transfer.abort': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer) return fail('unknown-transfer', '传输不存在或已结束');
            requireSession(transfer.sessionId);
            await cancelTransfer(transfer, 'aborted');
            return ok('storage.v1.transfer.abort', { aborted: true });
        },

        // --- downloads -----------------------------------------------------------------
        'storage.v1.snapshot.read': async data => {
            const session = requireSession(data.sessionId);
            if (session.downloadTransferId || session.uploadTransferId) {
                return fail('transfer-limit', '每个页面同时只能有一个进行中的工程传输');
            }
            const counts = frameTransferCounts(currentEvent());
            if (counts.downloads >= STORAGE_MAX_TRANSFERS_PER_FRAME) return fail('transfer-limit', '已存在进行中的下载');
            let project, snapshot;
            try {
                project = db.getProject(session.projectId);
                if (!project) return fail('unknown-project', '项目不存在');
                snapshot = data.snapshotId
                    ? db.getSnapshot(session.projectId, data.snapshotId)
                    : (project.current ? db.getSnapshot(session.projectId, project.current.snapshotId) : null);
            } catch (error) { return projectErrorToFailure(error); }
            if (!snapshot) return fail('unknown-snapshot', '快照不存在');
            let bytes;
            try {
                bytes = await store.getObject(session.projectId, snapshot.digest, snapshot.length);
            } catch (error) { return projectErrorToFailure(error); }
            const transferId = randomUUID();
            transfers.set(transferId, {
                kind: 'download', transferId, sessionId: session.sessionId, projectId: session.projectId,
                bytes, offset: 0, snapshot, startedAt: now(), lastActivity: now(), event: currentEvent(),
                queue: Promise.resolve(), cancelled: undefined,
            });
            session.downloadTransferId = transferId;
            return ok('storage.v1.snapshot.read', {
                snapshot: { version: 'dsk.v1', snapshotId: snapshot.snapshotId, projectId: session.projectId, revision: snapshot.revision, digest: snapshot.digest, createdAt: snapshot.createdAt },
                transferId,
                length: snapshot.length,
                chunkSize: STORAGE_CHUNK_BYTES,
                chunks: Math.ceil(snapshot.length / STORAGE_CHUNK_BYTES),
            });
        },
        'storage.v1.snapshot.download.chunk': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer || transfer.kind !== 'download') return fail('unknown-transfer', '下载会话不存在或已结束');
            requireSession(transfer.sessionId);
            return enqueueTransferOperation(transfer, async () => {
                if (transfer.cancelled || !transfers.has(transfer.transferId)) {
                    return fail('unknown-transfer', '下载已取消或结束');
                }
                const start = transfer.offset;
                const slice = transfer.bytes.subarray(start, Math.min(start + STORAGE_CHUNK_BYTES, transfer.bytes.length));
                transfer.offset = start + slice.length;
                transfer.lastActivity = now();
                const final = transfer.offset >= transfer.bytes.length;
                if (final) {
                    transfers.delete(transfer.transferId);
                    const session = sessions.get(transfer.sessionId);
                    if (session) session.downloadTransferId = undefined;
                }
                return ok('storage.v1.snapshot.download.chunk', {
                    offset: start, data: slice.toString('base64'), final,
                });
            });
        },

        // --- backup / restore ----------------------------------------------------------
        'storage.v1.backup.create': async data => {
            let view;
            try { view = db.backupView(data.projectId); }
            catch (error) { return projectErrorToFailure(error); }
            if (!view.snapshots.length) return fail('unknown-snapshot', '项目还没有已保存的快照');
            if (view.snapshots.length > STORAGE_BACKUP_MAX_SNAPSHOTS) return fail('transfer-limit', '快照数量超出备份上限');
            const totalBytes = view.snapshots.reduce((sum, s) => sum + s.length, 0);
            if (totalBytes > STORAGE_BACKUP_MAX_BYTES) return fail('transfer-limit', '对象总大小超出备份上限');
            const chosen = await pickDirectory('选择备份位置', '备份项目库');
            if (!chosen) return ok('storage.v1.backup.create', { cancelled: true });
            const finalDir = path.join(chosen, `director-desk-backup-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
            const stagingDir = path.join(chosen, `.staging-${randomUUID()}`);
            try {
                await fsp.mkdir(path.join(stagingDir, 'objects'), { recursive: true });
                createBackupDatabase(path.join(stagingDir, 'library.sqlite'), {
                    project: {
                        projectId: view.project.projectId,
                        name: view.project.name,
                        revision: view.project.revision,
                        currentSnapshotId: view.project.current ? view.project.current.snapshotId : null,
                        createdAt: view.project.updatedAt,
                        updatedAt: view.project.updatedAt,
                    },
                    snapshots: view.snapshots,
                    createdAt: new Date(now()).toISOString(),
                });
                // R8: stream each object to the backup directory with a running hash/length check
                // instead of buffering whole objects; verify results before publishing.
                const objects = new Map();
                for (const snapshot of view.snapshots) {
                    if (objects.has(snapshot.digest)) continue;
                    await store.streamObjectToFile(view.project.projectId, snapshot.digest, snapshot.length,
                        path.join(stagingDir, 'objects', `${snapshot.digest}.json`));
                    objects.set(snapshot.digest, { digest: snapshot.digest, length: snapshot.length });
                }
                const manifest = {
                    version: 'director-desk-backup.v1',
                    contractVersion: 'dsk.v1',
                    sourceProjectId: view.project.projectId,
                    name: view.project.name,
                    createdAt: new Date(now()).toISOString(),
                    snapshots: view.snapshots.map(s => ({ snapshotId: s.snapshotId, revision: s.revision, digest: s.digest, length: s.length, createdAt: s.createdAt })),
                    objects: [...objects.values()],
                };
                await fsp.writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
                await fsp.rename(stagingDir, finalDir);
            } catch (error) {
                try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
                if (error && isStorageFailureReason(String(error.reason))) return projectErrorToFailure(error);
                return fail('io-failure', '备份写入失败，未生成有效备份');
            }
            return ok('storage.v1.backup.create', {
                projectId: view.project.projectId,
                name: view.project.name,
                snapshots: view.snapshots.length,
                objects: new Set(view.snapshots.map(s => s.digest)).size,
                bytes: totalBytes,
            });
        },
        'storage.v1.backup.restore': async () => {
            const chosen = await pickDirectory('选择备份目录', '恢复备份');
            if (!chosen) return fail('dialog-cancelled', '已取消恢复');
            let restored;
            try {
                restored = await restoreFromBackup(chosen);
            } catch (error) {
                if (error && isStorageFailureReason(String(error.reason))) return projectErrorToFailure(error);
                return fail('backup-invalid', '备份校验失败，未恢复任何数据');
            }
            return ok('storage.v1.backup.restore', {
                projectId: restored.projectId, name: restored.name,
                snapshots: restored.snapshots, revision: restored.revision,
            });
        },
    };

    // Uniform mapping of thrown storage errors (library/session guards) onto frozen reasons.
    const handlers = {};
    for (const [action, handler] of Object.entries(rawHandlers)) {
        handlers[action] = async data => {
            pendingOperations += 1; // R10: dialog waits and long operations count as busy
            try {
                if (disposed) return fail('storage-unavailable', '存储服务已停止');
                return await handler(data);
            } catch (error) {
                return projectErrorToFailure(error);
            } finally {
                pendingOperations -= 1;
            }
        };
    }

    async function pickDirectory(title, buttonLabel) {
        if (!dialog) throw Object.assign(Error('主进程未提供目录选择能力'), { reason: 'storage-unavailable' });
        const result = await dialog.showOpenDialog({
            title, buttonLabel, properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths || result.filePaths.length !== 1) return null;
        return result.filePaths[0];
    }

    function safeEntryName(name) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..')) {
            throw Object.assign(Error('备份内出现不受支持的文件名'), { reason: 'path-refused' });
        }
        return name;
    }

    async function lstatNoLinks(fullPath, label) {
        let stat;
        try { stat = await fsp.lstat(fullPath); } catch {
            throw Object.assign(Error(`${label}缺失或不可读`), { reason: 'backup-invalid' });
        }
        if (stat.isSymbolicLink()) {
            throw Object.assign(Error(`${label}不允许是符号链接或 junction`), { reason: 'path-refused' });
        }
        return stat;
    }

    /** Read-only validation of a backup directory (R3/R8), then registration as a brand-new
     * project. Every relation is checked before anything is registered; failures leave the
     * library and existing projects untouched. */
    async function restoreFromBackup(directory) {
        const dirStat = await lstatNoLinks(directory, '备份目录');
        if (!dirStat.isDirectory()) throw Object.assign(Error('备份路径不是目录'), { reason: 'backup-invalid' });
        const entries = await fsp.readdir(directory);
        const expected = ['library.sqlite', 'manifest.json', 'objects'];
        if (entries.length !== expected.length || !expected.every(name => entries.includes(name))) {
            throw Object.assign(Error('备份目录包含意外内容'), { reason: 'backup-invalid' });
        }
        for (const name of expected) await lstatNoLinks(path.join(directory, name), `备份内容 ${name}`);
        // R8: bound the manifest read before reading it.
        const manifestStat = await fsp.lstat(path.join(directory, 'manifest.json'));
        if (manifestStat.size > MANIFEST_MAX_BYTES) {
            throw Object.assign(Error('备份清单超过大小上限'), { reason: 'backup-invalid' });
        }
        let manifestRaw;
        try { manifestRaw = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
        catch { throw Object.assign(Error('备份清单不是有效的 JSON'), { reason: 'backup-invalid' }); }
        const manifest = verifiers.manifest.safeParse(manifestRaw);
        if (!manifest.success) throw Object.assign(Error('备份清单未通过契约校验'), { reason: 'backup-invalid' });
        const manifestData = manifest.data;
        const inspected = inspectBackupDatabase(path.join(directory, 'library.sqlite'));
        // Manifest and database must describe exactly the same project and snapshots.
        if (inspected.project.sourceProjectId !== manifestData.sourceProjectId || inspected.project.name !== manifestData.name
            || inspected.snapshots.length !== manifestData.snapshots.length
            || inspected.snapshots.some((s, i) => s.snapshotId !== manifestData.snapshots[i].snapshotId
                || s.revision !== manifestData.snapshots[i].revision || s.digest !== manifestData.snapshots[i].digest
                || s.length !== manifestData.snapshots[i].length || s.createdAt !== manifestData.snapshots[i].createdAt)) {
            throw Object.assign(Error('备份清单与数据库不一致'), { reason: 'backup-invalid' });
        }
        const objectsDir = path.join(directory, 'objects');
        // Junction/symlink containment: the real target of every path must stay inside the backup
        // directory. lstat alone cannot see through junctions on all platforms, so compare realpaths.
        let realBackup, realObjects;
        try {
            realBackup = fs.realpathSync(directory);
            realObjects = fs.realpathSync(objectsDir);
        } catch {
            throw Object.assign(Error('备份目录无法解析真实路径'), { reason: 'backup-invalid' });
        }
        if (realObjects !== path.join(realBackup, 'objects')) {
            throw Object.assign(Error('备份对象目录不允许是符号链接或 junction'), { reason: 'path-refused' });
        }
        const objectEntries = await fsp.readdir(objectsDir);
        const objectByDigest = new Map(manifestData.objects.map(o => [o.digest, o]));
        if (objectByDigest.size !== manifestData.objects.length) {
            throw Object.assign(Error('备份对象摘要重复'), { reason: 'backup-invalid' });
        }
        if (objectEntries.length !== objectByDigest.size) {
            throw Object.assign(Error('备份对象数量与清单不一致'), { reason: 'backup-invalid' });
        }
        // R3 closure: every snapshot must resolve inside the object set with the SAME length, and
        // every object must be referenced by at least one snapshot (no free-floating payload).
        for (const snapshot of manifestData.snapshots) {
            const object = objectByDigest.get(snapshot.digest);
            if (!object || object.length !== snapshot.length) {
                throw Object.assign(Error('快照引用的对象缺失或长度不符'), { reason: 'backup-invalid' });
            }
        }
        const referenced = new Set(manifestData.snapshots.map(s => s.digest));
        for (const digest of objectByDigest.keys()) {
            if (!referenced.has(digest)) {
                throw Object.assign(Error('备份包含未被快照引用的对象'), { reason: 'backup-invalid' });
            }
        }
        // R3 relation sanity: unique revisions, current pointer inside the snapshot set,
        // project revision equal to the newest snapshot revision.
        const revisions = manifestData.snapshots.map(s => s.revision);
        if (new Set(revisions).size !== revisions.length || revisions.some(r => r < 1)) {
            throw Object.assign(Error('备份快照版本不唯一或无效'), { reason: 'backup-invalid' });
        }
        if (inspected.project.currentSnapshotId && !manifestData.snapshots.some(s => s.snapshotId === inspected.project.currentSnapshotId)) {
            throw Object.assign(Error('备份当前快照指针不在快照集合内'), { reason: 'backup-invalid' });
        }
        if (inspected.project.revision !== Math.max(...revisions)) {
            throw Object.assign(Error('备份项目版本与快照集合不一致'), { reason: 'backup-invalid' });
        }
        for (const entry of objectEntries) {
            const match = /^([0-9a-f]{64})\.json$/.exec(safeEntryName(entry));
            if (!match || !objectByDigest.has(match[1])) {
                throw Object.assign(Error('备份对象与清单不一致'), { reason: 'backup-invalid' });
            }
            const fullPath = path.join(objectsDir, entry);
            const stat = await lstatNoLinks(fullPath, '备份对象');
            const expectedObject = objectByDigest.get(match[1]);
            // R8: verify size BEFORE reading; enforce the cumulative byte budget during the walk.
            if (stat.size !== expectedObject.length) {
                throw Object.assign(Error('备份对象大小与清单不符'), { reason: 'corrupt-object' });
            }
            let realFile;
            try { realFile = fs.realpathSync(fullPath); } catch {
                throw Object.assign(Error('备份对象无法解析真实路径'), { reason: 'backup-invalid' });
            }
            if (realFile !== path.join(realObjects, entry)) {
                throw Object.assign(Error('备份对象不允许符号链接或 junction 间接引用'), { reason: 'path-refused' });
            }
        }
        const totalBytes = manifestData.objects.reduce((sum, o) => sum + o.length, 0);
        if (totalBytes > STORAGE_BACKUP_MAX_BYTES) throw Object.assign(Error('备份对象总大小超出上限'), { reason: 'backup-invalid' });
        // Full content verification: size, digest and document validity for every object.
        let verifiedBytes = 0;
        for (const object of manifestData.objects) {
            const bytes = await fsp.readFile(path.join(objectsDir, `${object.digest}.json`));
            verifiedBytes += bytes.length;
            if (verifiedBytes > STORAGE_BACKUP_MAX_BYTES) {
                throw Object.assign(Error('备份对象总大小超出上限'), { reason: 'backup-invalid' });
            }
            if (bytes.length !== object.length || store.sha256Hex(bytes) !== object.digest) {
                throw Object.assign(Error('备份对象内容校验失败'), { reason: 'corrupt-object' });
            }
            let parsed;
            try { parsed = JSON.parse(bytes.toString('utf8')); }
            catch { throw Object.assign(Error('备份对象不是有效的 JSON'), { reason: 'corrupt-object' }); }
            const scan = scanStorageProject(parsed);
            if (scan) throw Object.assign(Error('备份对象超出负载限制'), { reason: 'document-invalid' });
            try { verifiers.document(parsed); }
            catch { throw Object.assign(Error('备份对象工程校验失败'), { reason: 'document-invalid' }); }
        }
        // Register as a brand-new project with remapped ids; objects are streamed into the new
        // project directory (hash verified while streaming) and re-read for proof before the
        // single registration transaction (R3: 校验后替换防护).
        const newProjectId = randomUUID();
        const idMap = new Map(manifestData.snapshots.map(s => [s.snapshotId, randomUUID()]));
        try {
            for (const object of manifestData.objects) {
                await store.streamFileToObject(path.join(objectsDir, `${object.digest}.json`), newProjectId, object.digest, object.length);
                // Copy-then-re-read: the published bytes must still hash/verify as expected.
                await store.getObject(newProjectId, object.digest, object.length);
            }
            const currentSnapshot = manifestData.snapshots.find(s => s.snapshotId === inspected.project.currentSnapshotId);
            await db.restoreProject({
                project: {
                    projectId: newProjectId,
                    name: manifestData.name,
                    revision: manifestData.snapshots.length ? Math.max(...manifestData.snapshots.map(s => s.revision)) : 0,
                    currentSnapshotId: currentSnapshot ? idMap.get(currentSnapshot.snapshotId) : null,
                    createdAt: new Date(now()).toISOString(),
                    updatedAt: new Date(now()).toISOString(),
                },
                snapshots: manifestData.snapshots.map(s => ({
                    snapshotId: idMap.get(s.snapshotId),
                    revision: s.revision,
                    digest: s.digest,
                    length: s.length,
                    createdAt: s.createdAt,
                })),
            });
        } catch (error) {
            try { await store.removeProject(newProjectId); } catch { /* best effort */ }
            throw error;
        }
        return {
            projectId: newProjectId,
            name: manifestData.name,
            snapshots: manifestData.snapshots.length,
            revision: manifestData.snapshots.length ? Math.max(...manifestData.snapshots.map(s => s.revision)) : 0,
        };
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearInterval(sweeper);
        closeFrameSessions();
        try { db.close(); } catch { /* already closed */ }
    }

    return {
        handlers,
        isBusy: () => transfers.size + pendingOperations > 0,
        sessionCount: () => sessions.size,
        pendingOperationCount: () => pendingOperations,
        closeFrameSessions,
        dispose,
        /** Bind one trusted IPC event to the storage request context for the duration of a dispatch. */
        runInRequestContext: (event, fn) => requestContext.run(event, fn),
        // Test/inspection hooks (not part of the IPC surface).
        _internal: { sessions, transfers, db, store, sweepTransfers },
    };
}

module.exports = { createStorageService, createUnavailableStorageService };
