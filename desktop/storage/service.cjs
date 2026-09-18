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
// RP2/R2: dispose is the awaitable, bounded, single-owner exit drain — it stops accepting requests
// and advances the generation synchronously, drains in-flight handlers plus every tracked
// cleanup (including cleanups detached from the transfer map) under an independent real-clock
// budget, really retries every FAILED cleanup through an unresolved-resource ledger, and closes
// the database only when nothing is pending or unaccounted; timeout/cleanup/db-close failures
// return explicit blocked results with the database kept open and retryable.
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
// F06: the manifest budget is derived from the APPROVED backup maximums, not an arbitrary cap.
// Worst case at STORAGE_BACKUP_MAX_SNAPSHOTS = 10000: each pretty-printed snapshot entry measures
// ~250 bytes (uuid + ISO date + 64-hex digest + revision + JSON syntax), so 10000 x 260 = 2.6 MB;
// objects are bounded by distinct digests (<= one per snapshot): 10000 x ~96 = 0.96 MB; the fixed
// header is < 1 KB. Total < 3.7 MB, so 4 MiB admits every legal self-produced backup (5000 and
// 10000 snapshots must round-trip) while still refusing adversarial multi-megabyte manifests.
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

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
        // RP2: consistent dispose contract — nothing to drain and no database, resolves ready.
        dispose() { return Promise.resolve({ ok: true }); },
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
    leaseTtlMs = 30000, leaseRenewMs = 10000, library, objects,
    removeTmp = target => fsp.rm(target, { force: true }),
    ensureDir = target => fsp.mkdir(target, { recursive: true }) } = {}) {
    const requestContext = new AsyncLocalStorage();
    const store = objects ?? createObjectStore({ root });
    const db = library ?? openLibrary({ file: path.join(root, 'library.sqlite'), now });
    const sessions = new Map(); // sessionId -> session
    const transfers = new Map(); // transferId -> transfer
    let pendingOperations = 0; // R10: in-flight handler operations (incl. dialog waits)
    let disposed = false;
    // RP1: monotonically advancing request generation. Every dispatch captures the current
    // value in its request context; closeFrameSessions()/dispose() advance it SYNCHRONOUSLY,
    // so a reload/close instantly invalidates every in-flight token: late dialog returns,
    // copy iterations, backup publishes and restore registrations observe the stale token
    // and stop without writing, while new-generation requests keep working.
    let frameGeneration = 0;

    const sweeper = setInterval(() => sweepTransfers(), Math.min(15000, Math.max(1000, Math.floor(STORAGE_UPLOAD_IDLE_MS / 4))));
    sweeper.unref?.();

    // RP2: cleanup registry. Cancellations continue running AFTER their transfer left the map
    // (sweeper timeouts, reload/abort fire-and-forget drains, session-close tmp deletions). The
    // exit drain must wait for those too, so every cleanup promise that is not already covered
    // by an awaited handler is tracked here and self-removes when settled.
    const pendingCleanups = new Set();
    const cleanupErrors = [];
    function trackCleanup(promise) {
        const entry = promise.then(
            () => { pendingCleanups.delete(entry); },
            error => { pendingCleanups.delete(entry); cleanupErrors.push(error); });
        pendingCleanups.add(entry);
        return promise;
    }

    // RP2-R2: ledger of cleanup resources that FAILED and are therefore still unaccounted for
    // (a transfer handle that refused to close, a .part file that refused to be removed). An
    // entry leaves this ledger ONLY when its resource is actually cleaned by a real retry —
    // never by a later dispose resetting an error counter. While the ledger is non-empty the
    // drain stays blocked and the database stays open.
    const unresolvedCleanups = new Map(); // key -> { transfer, stage: 'close' | 'rm', error }
    // RP2-F1: retry attempts run as OBSERVABLE IN-FLIGHT work. The drain starts them but never
    // awaits them inline — a hanging close/rm must not stretch the drain past its real deadline.
    // At most one attempt per resource may be in flight, across dispose calls. Attempts that
    // are still running when the budget ends simply stay running (and stay accounted for).
    const inflightCleanups = new Map(); // key -> attempt promise
    let unresolvedSeq = 0;
    let lastCleanupRetryStartedAt = 0;
    function isAlreadyClosedError(error) {
        return Boolean(error) && (error.code === 'ERR_STREAM_ALREADY_CLOSED' || /already closed/i.test(String(error && error.message)));
    }
    function recordUnresolvedCleanup(transfer, stage, error) {
        cleanupErrors.push(error);
        unresolvedCleanups.set(`${transfer.transferId}:${stage}:${unresolvedSeq++}`, { transfer, stage, error });
    }
    function startCleanupRetry(key, entry) {
        if (inflightCleanups.has(key)) return; // never two concurrent attempts for one resource
        const attempt = (async () => {
            try {
                if (entry.stage === 'close') {
                    await entry.transfer.handle?.close();
                } else {
                    await fsp.rm(entry.transfer.tmpPath, { force: true });
                }
                unresolvedCleanups.delete(key); // the resource is REALLY accounted for now
            } catch (error) {
                if (entry.stage === 'close' && isAlreadyClosedError(error)) {
                    unresolvedCleanups.delete(key); // the handle is provably closed: resolved
                    return;
                }
                entry.error = error; // stays in the ledger for the next bounded attempt
            } finally {
                inflightCleanups.delete(key);
            }
        })();
        inflightCleanups.set(key, attempt);
    }
    /** F1: START due retry attempts (bounded real-clock cadence) without awaiting them — the
     * drain's overall deadline covers in-flight attempts through the size checks below. */
    function startDueCleanupRetries() {
        if (unresolvedCleanups.size === 0) return;
        const at = Date.now();
        if (at - lastCleanupRetryStartedAt < 100) return;
        lastCleanupRetryStartedAt = at;
        for (const [key, entry] of [...unresolvedCleanups]) startCleanupRetry(key, entry);
    }

    function sweepTransfers() {
        const at = now();
        for (const transfer of [...transfers.values()]) {
            const idle = at - transfer.lastActivity > STORAGE_UPLOAD_IDLE_MS;
            const total = at - transfer.startedAt > STORAGE_TRANSFER_TOTAL_MS;
            if (idle || total) void trackCleanup(cancelTransfer(transfer, 'timeout'));
        }
    }

    function currentEvent() {
        const token = requestContext.getStore();
        return token ? token.event : null;
    }

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
            // RP2/R2: cleanup failures are recorded in the unresolved-cleanup ledger and are
            // surfaced through the exit drain as an explicit blocked result — and really retried
            // by later drains — instead of vanishing or being written off by a fresh baseline.
            try { await transfer.handle?.close(); }
            catch (error) { if (!isAlreadyClosedError(error)) recordUnresolvedCleanup(transfer, 'close', error); }
            try { await fsp.rm(transfer.tmpPath, { force: true }); }
            catch (error) { recordUnresolvedCleanup(transfer, 'rm', error); }
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
        if (!session) return [];
        sessions.delete(sessionId);
        stopRenewal(session);
        // F04/F12: collect the cancellation promises so callers can drain tmp-file cleanup before
        // closing the database or finishing navigation. RP2: every cancellation is also tracked
        // in the cleanup registry, so fire-and-forget callers (reload, handler paths that drop
        // the returned array) stay covered by the exit drain.
        const cancellations = [];
        for (const transfer of [...transfers.values()]) {
            if (transfer.sessionId === sessionId) cancellations.push(trackCleanup(cancelTransfer(transfer, 'session-closed')));
        }
        if (session.leaseOwned && session.lease) {
            try { db.releaseLease(session.projectId, session.lease.owner, session.lease.generation); } catch { /* best effort */ }
        }
        return cancellations;
    }

    /** F04/F12: awaitable drain — every transfer cancellation (incl. tmp file removal) has
     * settled when the returned promise resolves. RP1: the generation advances BEFORE any
     * await so invalidation is synchronous with the reload/close event (did-start-loading /
     * dispose); the returned promise only covers the tmp-file draining. */
    function closeFrameSessions() {
        frameGeneration += 1;
        return Promise.all([...sessions.keys()].flatMap(sessionId => closeSession(sessionId)));
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
                await store.trustedSubdir(UPLOADS_DIR);
                transfer.handle = await fsp.open(tmpPath, 'wx');
            } catch (error) {
                await cancelTransfer(transfer, 'tmp-open-failed');
                if (error && error.reason === 'path-refused') return projectErrorToFailure(error);
                return fail('io-failure', '上传临时文件创建失败');
            }
            // F04: the tmp file was opened after awaits — re-check that the session/frame is still
            // alive before answering success; a late success must not leak a handle or a .part.
            // RP1: requestGone() also covers a generation bumped by a mid-flight reload/close.
            if (!sessions.has(session.sessionId) || transfer.cancelled || !transfers.has(transferId) || requestGone()) {
                // cancelTransfer early-returns for an already-removed transfer; close and clean
                // up directly so neither the handle nor the .part file outlives the frame.
                // RP2/R2: real failures here join the unresolved-cleanup ledger like everywhere
                // else — only "already closed" is tolerated, never a genuine resource leak.
                try { await transfer.handle?.close(); }
                catch (error) { if (!isAlreadyClosedError(error)) recordUnresolvedCleanup(transfer, 'close', error); }
                try { await fsp.rm(tmpPath, { force: true }); }
                catch (error) { recordUnresolvedCleanup(transfer, 'rm', error); }
                if (transfers.has(transferId)) await cancelTransfer(transfer, 'session-closed');
                return fail('unknown-session', '存储会话已关闭，上传未创建');
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
                // RP1: the generation-aware requestGone() joins every liveness re-check below, so
                // a request dispatched in an older frame generation can never keep executing.
                if (transfer.cancelled || !transfers.has(transfer.transferId) || !sessions.has(session.sessionId) || requestGone()) {
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
                // F04: re-check liveness after every await — an abort that landed while this
                // operation was queued or awaiting must win, never the late commit.
                // RP1: requestGone() extends this to a generation bumped by reload/close.
                if (transfer.cancelled || !transfers.has(transfer.transferId) || !sessions.has(session.sessionId) || requestGone()) {
                    return fail('unknown-transfer', '传输已取消或会话已关闭');
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
                // F04: the object write awaited — the abort may have landed in that window.
                // RP1: last cancellable point before the registration boundary; requestGone()
                // joins the check so a mid-flight reload/close wins over the late commit.
                if (transfer.cancelled || !transfers.has(transfer.transferId) || !sessions.has(session.sessionId) || requestGone()) {
                    return fail('unknown-transfer', '传输已取消或会话已关闭');
                }
                // RP1: final atomic arbitration. Nothing may await between this re-check and the
                // synchronous db.commitSnapshot return, so a reload/close can never slip into the
                // registration window; a transfer that lost the race never registers (no cancel
                // success followed by a late commit).
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
                    try { await removeTmp(transfer.tmpPath); } catch { /* best effort */ }
                    // Object may be published while registration failed: it stays an untrusted orphan.
                    return projectErrorToFailure(error);
                }
                // RP1/R01: the ENTIRE post-commit receipt section stays inside the same synchronous
                // arbitration section — NO await — so a reload cannot split it:
                // - the receipt revision is pinned to THIS request's own commit (expectedRevision+1,
                //   enforced by the commitSnapshot guards); reading the project row after a later
                //   await could observe a NEWER revision saved by a new generation and forge a
                //   receipt pairing this request's snapshotId with that future revision;
                // - this request's project rename is arbitrated in the SAME main-process, zero-await
                //   event-loop turn as the registration (same JS turn, NOT one database transaction
                //   and NOT cross-process atomicity — other processes are still fenced by the lease);
                //   it therefore cannot run after a reload handed the project to a new generation;
                // - from here the commit is provably registered (F07): the tmp cleanup below may
                //   suspend or fail freely and must never be reported as an uncommitted save.
                const revision = transfer.expectedRevision + 1;
                let currentName = null;
                try { currentName = db.getProject(transfer.projectId)?.name ?? null; } catch { /* receipt unavailable */ }
                if (transfer.name && currentName && currentName !== transfer.name) {
                    try { db.renameProject(transfer.projectId, transfer.name); session.name = transfer.name; } catch { /* rename is best effort */ }
                }
                const snapshotRef = { version: 'dsk.v1', snapshotId, projectId: transfer.projectId, revision, digest, createdAt };
                session.revision = revision;
                session.current = snapshotRef;
                try { await removeTmp(transfer.tmpPath); } catch { /* best effort; the commit stands */ }
                return ok('storage.v1.upload.commit', { snapshot: snapshotRef, revision });
            });
        },
        'storage.v1.transfer.abort': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer) return fail('unknown-transfer', '传输不存在或已结束');
            requireSession(transfer.sessionId);
            // F04: route the abort through the same serial queue as every other operation, so an
            // abort can never interleave with a mid-flight commit — exactly one of them wins.
            return enqueueTransferOperation(transfer, async () => {
                if (!transfers.has(transfer.transferId) || transfer.cancelled) {
                    return fail('unknown-transfer', '传输已取消或结束，操作被拒绝');
                }
                await cancelTransfer(transfer, 'aborted');
                return ok('storage.v1.transfer.abort', { aborted: true });
            });
        },

        // --- downloads -----------------------------------------------------------------
        'storage.v1.snapshot.read': async data => {
            const session = requireSession(data.sessionId);
            if (session.downloadTransferId || session.uploadTransferId) {
                return fail('transfer-limit', '每个页面同时只能有一个进行中的工程传输');
            }
            const counts = frameTransferCounts(currentEvent());
            if (counts.downloads >= STORAGE_MAX_TRANSFERS_PER_FRAME) return fail('transfer-limit', '已存在进行中的下载');
            // F04: the slot is reserved synchronously BEFORE any await — two concurrent reads can
            // no longer both slip through the check while the object is being read.
            const transferId = randomUUID();
            const transfer = {
                kind: 'download', transferId, sessionId: session.sessionId, projectId: session.projectId,
                bytes: null, pending: true, offset: 0, snapshot: null,
                startedAt: now(), lastActivity: now(), event: currentEvent(),
                queue: Promise.resolve(), cancelled: undefined,
            };
            transfers.set(transferId, transfer);
            session.downloadTransferId = transferId;
            try {
                let project, snapshot;
                try {
                    project = db.getProject(session.projectId);
                    if (!project) throw Object.assign(Error('项目不存在'), { reason: 'unknown-project' });
                    snapshot = data.snapshotId
                        ? db.getSnapshot(session.projectId, data.snapshotId)
                        : (project.current ? db.getSnapshot(session.projectId, project.current.snapshotId) : null);
                } catch (error) {
                    await cancelTransfer(transfer, 'lookup-failed');
                    if (error && error.reason === 'unknown-project') return fail('unknown-project', '项目不存在');
                    return projectErrorToFailure(error);
                }
                if (!snapshot) {
                    await cancelTransfer(transfer, 'unknown-snapshot');
                    return fail('unknown-snapshot', '快照不存在');
                }
                const bytes = await store.getObject(session.projectId, snapshot.digest, snapshot.length);
                // F04: the object read awaited — re-check that this transfer is still the live one.
                // RP1: requestGone() extends this to a generation bumped by reload/close.
                if (transfer.cancelled || !transfers.has(transferId) || !sessions.has(session.sessionId) || requestGone()) {
                    return fail('unknown-transfer', '下载已取消或结束');
                }
                transfer.bytes = bytes;
                transfer.pending = false;
                transfer.snapshot = snapshot;
                return ok('storage.v1.snapshot.read', {
                    snapshot: { version: 'dsk.v1', snapshotId: snapshot.snapshotId, projectId: session.projectId, revision: snapshot.revision, digest: snapshot.digest, createdAt: snapshot.createdAt },
                    transferId,
                    length: snapshot.length,
                    chunkSize: STORAGE_CHUNK_BYTES,
                    chunks: Math.ceil(snapshot.length / STORAGE_CHUNK_BYTES),
                });
            } catch (error) {
                await cancelTransfer(transfer, 'read-failed');
                return projectErrorToFailure(error);
            }
        },
        'storage.v1.snapshot.download.chunk': async data => {
            const transfer = transfers.get(data.transferId);
            if (!transfer || transfer.kind !== 'download') return fail('unknown-transfer', '下载会话不存在或已结束');
            requireSession(transfer.sessionId);
            return enqueueTransferOperation(transfer, async () => {
                if (transfer.cancelled || !transfers.has(transfer.transferId) || transfer.pending || !transfer.bytes) {
                    return fail('unknown-transfer', '下载已取消或尚未就绪');
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
            // F12: the dialog awaited — re-check the service/frame before any staging or publish.
            const goneAfterPick = requestGone();
            if (goneAfterPick) return fail('storage-unavailable', `${goneAfterPick}，备份未创建`);
            const finalDir = path.join(chosen, `director-desk-backup-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
            const stagingDir = path.join(chosen, `.staging-${randomUUID()}`);
            try {
                await ensureDir(path.join(stagingDir, 'objects'));
                // RP1/R02: the staging creation awaited — re-check BEFORE the backup database is
                // created or the FIRST object is copied. An invalidation during the staging mkdir
                // must leave zero copies and zero published directories; only this request's own
                // staging directory is removed and existing data is untouched.
                const goneBeforeStaging = requestGone();
                if (goneBeforeStaging) {
                    try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
                    return fail('storage-unavailable', `${goneBeforeStaging}，备份未发布`);
                }
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
                    // RP1: 复制迭代完成复核 — a reload/close that landed during the copy stops the
                    // staging here; the staging directory is cleaned and nothing is published.
                    const goneMidCopy = requestGone();
                    if (goneMidCopy) {
                        try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
                        return fail('storage-unavailable', `${goneMidCopy}，备份未发布`);
                    }
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
                // F12/RP1: publish only into a still-live context; late returns clean up staging.
                // This is the backup's LAST cancellable point — once the rename starts the publish
                // is committed: there is no cancellation past it, the result is reported truthfully
                // (F07-style receipt) and no cleanup path may delete the published directory.
                const goneBeforePublish = requestGone();
                if (goneBeforePublish) {
                    try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
                    return fail('storage-unavailable', `${goneBeforePublish}，备份未发布`);
                }
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
            // F12: the dialog awaited — never register a restore for a dead service/frame.
            const goneAfterPick = requestGone();
            if (goneAfterPick) return fail('storage-unavailable', `${goneAfterPick}，恢复未执行`);
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

    /** F12/RP1: after every await (dialog pick, copy iteration, staging writes) the requesting
     * context is re-checked: a disposed service, a request captured in a superseded frame
     * generation (reload/close advanced it) or a destroyed sender frame must never publish a
     * backup, register a restore or commit a transfer. Returns a human reason when the request
     * has lost its context, null otherwise. A missing token (direct internal call) keeps the
     * legacy disposed/destroyed behavior only. */
    function requestGone() {
        if (disposed) return '存储服务已停止';
        const token = requestContext.getStore();
        if (token && token.generation !== frameGeneration) return '页面已重新载入';
        if (token && token.event && token.event.sender && typeof token.event.sender.isDestroyed === 'function' && token.event.sender.isDestroyed()) {
            return '页面已关闭';
        }
        return null;
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
        // R3/F03 relation sanity: unique revisions, current pointer present and pointing at the
        // newest snapshot. A NULL current with non-empty snapshots (or a stale/foreign pointer)
        // must be rejected — such a backup can never be re-registered as a coherent project.
        const revisions = manifestData.snapshots.map(s => s.revision);
        if (new Set(revisions).size !== revisions.length || revisions.some(r => r < 1)) {
            throw Object.assign(Error('备份快照版本不唯一或无效'), { reason: 'backup-invalid' });
        }
        if (manifestData.snapshots.length) {
            if (!inspected.project.currentSnapshotId) {
                throw Object.assign(Error('备份包含快照但缺少当前快照指针'), { reason: 'backup-invalid' });
            }
            const currentSnapshot = manifestData.snapshots.find(s => s.snapshotId === inspected.project.currentSnapshotId);
            if (!currentSnapshot) {
                throw Object.assign(Error('备份当前快照指针不在快照集合内'), { reason: 'backup-invalid' });
            }
            if (currentSnapshot.revision !== Math.max(...revisions)) {
                throw Object.assign(Error('备份当前快照指针不是最新版本'), { reason: 'backup-invalid' });
            }
            if (inspected.project.revision !== Math.max(...revisions)) {
                throw Object.assign(Error('备份项目版本与快照集合不一致'), { reason: 'backup-invalid' });
            }
        } else if (inspected.project.currentSnapshotId) {
            throw Object.assign(Error('空备份不允许携带当前快照指针'), { reason: 'backup-invalid' });
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
        // RP1: 复制开始/迭代完成/登记前复核 — every check throws a live-request error that the
        // caller maps onto the frozen storage-unavailable shape; the staged new project
        // directory is removed by the catch below, and the original projects and existing
        // backups stay untouched.
        const requireLiveRequest = () => {
            const gone = requestGone();
            if (gone) throw Object.assign(Error(`${gone}，恢复未登记`), { reason: 'storage-unavailable' });
        };
        const newProjectId = randomUUID();
        const idMap = new Map(manifestData.snapshots.map(s => [s.snapshotId, randomUUID()]));
        requireLiveRequest(); // 复制开始前
        try {
            for (const object of manifestData.objects) {
                await store.streamFileToObject(path.join(objectsDir, `${object.digest}.json`), newProjectId, object.digest, object.length);
                // Copy-then-re-read: the published bytes must still hash/verify as expected.
                await store.getObject(newProjectId, object.digest, object.length);
                requireLiveRequest(); // 复制迭代完成复核
            }
            // 恢复 DB 登记前的最后复核：runImmediate 的注册事务同步完成，此处与事务之间没有 await，
            // 复核通过后不存在可插入的失效窗口（已开始登记即不可取消，结果如实返回）。
            requireLiveRequest();
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
            // RP1: removeProject clears the staged objects; also drop the now-empty project
            // shell so a cancelled restore leaves nothing behind. rmdir only succeeds when the
            // directory is EMPTY, so this can never delete staged object bytes or user data —
            // best effort, ignored when the shell is gone or not empty.
            try { await fsp.rmdir(path.join(root, 'projects', newProjectId), { force: true }); } catch { /* best effort */ }
            throw error;
        }
        return {
            projectId: newProjectId,
            name: manifestData.name,
            snapshots: manifestData.snapshots.length,
            revision: manifestData.snapshots.length ? Math.max(...manifestData.snapshots.map(s => s.revision)) : 0,
        };
    }

    // --- RP2: awaitable, bounded, single-owner exit drain -----------------------------
    const DISPOSE_DEFAULT_TIMEOUT_MS = 10000;
    let drainPromise = null;   // in-flight (or last blocked) drain; retryable after a blocked result
    let closedResult = null;   // cached success: the database was closed exactly once

    async function performDrain(timeoutMs) {
        // The drain budget is an independent REAL wall clock. The injectable business clock
        // (`now`) may be frozen (tests, suspended clocks) and must never control the exit wait.
        const deadline = Date.now() + timeoutMs;
        let sessionDrainSettled = false;
        // NOTE: the aggregate is deliberately NOT registered into pendingCleanups — that would
        // make the drain wait on itself (the per-cancellation promises are tracked instead).
        void closeFrameSessions().then(
            () => { sessionDrainSettled = true; },
            () => { sessionDrainSettled = true; });
        // One bounded loop covers session cancellations, in-flight handlers, every tracked
        // cleanup AND every unresolved failed cleanup. Failed cleanups are STARTED as
        // non-blocking in-flight retries on a bounded cadence — the loop never awaits a retry
        // inline, so a hanging close/rm cannot stretch the wait past the deadline. Past the
        // deadline no NEW attempts are started; running/failed/pending work stays accounted.
        while (Date.now() < deadline) {
            startDueCleanupRetries();
            if (sessionDrainSettled && pendingOperations === 0 && pendingCleanups.size === 0 && transfers.size === 0 && unresolvedCleanups.size === 0 && inflightCleanups.size === 0) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (unresolvedCleanups.size > 0 || inflightCleanups.size > 0) {
            const last = cleanupErrors[cleanupErrors.length - 1];
            return {
                ok: false,
                blocked: 'cleanup-failed',
                detail: `退出期间后台清理失败且尚未解决（失败未解决 ${unresolvedCleanups.size} 项，重试进行中 ${inflightCleanups.size} 项，最近错误：${last && last.code ? last.code : '未知错误'}），失败资源保持记账、进行中的重试不打断；项目库保持打开。`,
                unresolvedCleanups: unresolvedCleanups.size,
                inflightCleanups: inflightCleanups.size,
            };
        }
        if (!sessionDrainSettled || pendingOperations > 0 || pendingCleanups.size > 0 || transfers.size > 0) {
            return {
                ok: false,
                blocked: 'timeout',
                detail: `退出等待超时：仍有未完成的存储操作（会话排空：${sessionDrainSettled ? '已完成' : '进行中'}，处理中：${pendingOperations}，后台清理：${pendingCleanups.size}，传输：${transfers.size}）。项目库保持打开，可重试等待。`,
                pending: { handlers: pendingOperations, cleanups: pendingCleanups.size, transfers: transfers.size },
            };
        }
        // db.close() is synchronous and may throw: the error becomes an explicit blocked result.
        // It is never swallowed into a fake normal close, and the library is never reopened.
        try { db.close(); } catch (error) {
            return { ok: false, blocked: 'db-close-failed', detail: `项目库关闭失败：${error && error.message ? error.message : error}` };
        }
        return { ok: true, cleanupErrors: cleanupErrors.length };
    }

    /** RP2/R2: the only path that stops the service. Synchronously, before its first await, it
     * refuses new requests, advances the frame generation (RP1 invalidation) and stops the
     * sweeper. It then drains handlers, tracked cleanups and every unresolved failed cleanup
     * (genuinely retried on a bounded cadence) within a REAL bounded budget and closes the
     * database only when NOTHING is pending or unaccounted. Timeout, cleanup failure and a
     * throwing db.close() return an explicit blocked result with the database left OPEN; a
     * later call retries in a controlled way (it waits on and retries the SAME original work —
     * no reopen, no baseline reset that would write off failed resources). Concurrent/repeat
     * calls share one in-flight promise; success is cached. */
    function dispose({ timeoutMs } = {}) {
        if (closedResult) return Promise.resolve(closedResult);
        if (!drainPromise) {
            disposed = true;
            frameGeneration += 1;
            clearInterval(sweeper);
            const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DISPOSE_DEFAULT_TIMEOUT_MS;
            const promise = (async () => {
                try { return await performDrain(budget); }
                catch (error) {
                    return { ok: false, blocked: 'internal', detail: `退出排空内部错误：${error && error.message ? error.message : error}` };
                }
            })();
            drainPromise = promise;
            void promise.then(result => {
                if (result && result.ok === true) closedResult = result;
                if (drainPromise === promise) drainPromise = null; // blocked results become retryable
            }, () => {
                if (drainPromise === promise) drainPromise = null;
            });
            return promise;
        }
        return drainPromise;
    }

    return {
        handlers,
        isBusy: () => transfers.size + pendingOperations > 0,
        sessionCount: () => sessions.size,
        pendingOperationCount: () => pendingOperations,
        closeFrameSessions,
        dispose,
        /** Bind one trusted IPC event to the storage request context for the duration of a dispatch.
         * RP1: the context token captures the current frame generation next to the event, so every
         * request carries the generation it was created in and can detect invalidation later. */
        runInRequestContext: (event, fn) => requestContext.run({ event, generation: frameGeneration }, fn),
        // Test/inspection hooks (not part of the IPC surface).
        _internal: {
            sessions, transfers, db, store, sweepTransfers,
            frameGeneration: () => frameGeneration,
            // RP2 exit-drain state: 'open' | 'draining' | 'ready' | 'blocked-retryable'.
            drainState: () => closedResult ? 'ready'
                : drainPromise ? 'draining' : 'blocked-retryable',
            pendingCleanupCount: () => pendingCleanups.size,
            unresolvedCleanupCount: () => unresolvedCleanups.size,
            inflightCleanupCount: () => inflightCleanups.size,
            dbOpen: () => { try { db.listProjects({ limit: 1 }); return true; } catch { return false; } },
        },
    };
}

module.exports = { createStorageService, createUnavailableStorageService };
