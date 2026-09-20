// DSK-004: content-addressed immutable project object store.
// Layout: <root>/projects/<projectId>/objects/<sha256>.json holding the canonical document bytes.
// Publication order: write tmp file -> flush -> close -> rename on the same directory -> sync dir.
// A file only exists under its final digest name after the bytes are durable; readers verify size
// and digest before trusting content. Missing/corrupt/orphan objects are reported, never repaired
// or silently deleted. Pure Node: no Electron imports; fs/clock/random are injectable for tests.
// RP4: every read entry point runs through ONE bounded-read core — validated limits (safe
// non-negative integer, +1 sentinel that cannot overflow, declared length <= the 64MiB object
// budget), trusted-path link refusal, a post-open handle.stat (regular file + size, so an
// initially oversized handle costs ZERO content reads), per-request reads of at most
// min(64KiB, limit+1-total), short-read looping until a REAL 0-byte EOF (never a busy loop),
// overflow sentinel bytes that are never delivered to the sink, exact length/hash verification,
// and detailed per-read telemetry (request/return/cumulative bytes, fstat count, phase order,
// close result) — not just _lastReadBytes. Close failures are never swallowed: the handle is
// handed SYNCHRONOUSLY to exactly one owner — the service cleanup ledger through the injected
// onReadCloseFailure sink, or the independent caller through the thrown error — while the
// primary read error is preserved alongside the close failure. Business byte budgets and the
// actual multi-round I/O telemetry are kept strictly separate.
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const OBJECT_EXT = '.json';
// Default cap for reads without a declared length; matches the approved 64MiB project budget.
const OBJECT_MAX_BYTES = 64 * 1024 * 1024;
// RP4: internal read block for every bounded read/stream. This is NOT the 48KiB IPC chunk size;
// each single read request never exceeds min(READ_CHUNK, limit+1-totalRead).
const READ_CHUNK = 64 * 1024;
// Per-session request trace cap so adversarial/growing inputs cannot grow telemetry unbounded.
const REQUEST_TRACE_MAX = 50000;

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function projectDir(root, projectId) {
    // projectId is validated by the contract layer ([A-Za-z0-9][A-Za-z0-9._-]{0,63}); the guard
    // here keeps path traversal out even if a caller forgets.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectId)) throw Error('项目标识无效');
    return path.join(root, 'projects', projectId, 'objects');
}

function tmpName() {
    return `.tmp-${process.pid}-${crypto.randomUUID()}`;
}

function isAlreadyClosedError(error) {
    return Boolean(error) && (error.code === 'ERR_STREAM_ALREADY_CLOSED' || /already closed/i.test(String(error && error.message)));
}

/** RP4: a read limit must be a safe, finite, non-negative integer whose +1 sentinel cannot
 * overflow, and a DECLARED length may never exceed the 64MiB object budget. Invalid limits are
 * refused before the file is opened, so no content is read for them. */
function assertBoundedLimit(limit, maxBytes, label, refusalReason) {
    if (limit === undefined) return maxBytes;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
        throw Object.assign(Error(`${label}登记长度不是安全的非负整数`), { reason: refusalReason });
    }
    if (limit > maxBytes) {
        throw Object.assign(Error(`${label}登记长度超过对象预算上限`), { reason: refusalReason });
    }
    return limit;
}

/** RP4: partial-write loop for streaming sinks — a short write continues from where the last
 * write stopped until every byte of the chunk is on disk (or the write genuinely fails). */
async function writeFully(handle, buffer) {
    let written = 0;
    while (written < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, null);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
            throw Object.assign(Error('目标写入失败（零字节写入）'), { reason: 'io-failure' });
        }
        written += bytesWritten;
    }
}

/** Create one object store rooted at <root>/projects. faults.{write,sync,close,rename} inject I/O
 * failures. onReadCloseFailure (RP4, internal DI): sink for read-handle close failures — the
 * service binds it to the existing RP2 unresolved-cleanup ledger. When absent (independent
 * callers), close failures propagate to the caller, who explicitly takes the resource over. */
function createObjectStore({ root, faults = {}, maxBytes = OBJECT_MAX_BYTES, onReadCloseFailure = null } = {}) {
    const call = (hook, fallback) => hook ? hook() : fallback();
    let realRoot;
    const ensureRealRoot = () => {
        if (!realRoot) {
            // The root may not exist yet (fresh stores); create it before resolving the real path.
            fsSync.mkdirSync(root, { recursive: true });
            realRoot = fsSync.realpathSync(root);
        }
        return realRoot;
    };
    // RP4 telemetry: per-session traces (bounded ring) plus aggregate counters. This is actual
    // multi-round I/O evidence and is deliberately SEPARATE from every business byte budget.
    let readSessionSeq = 0;
    let handleSeq = 0;
    let lastReadBytes = 0;
    const readSessionLog = [];
    const aggregate = {
        sessions: 0, fstatCalls: 0, readCalls: 0, readRequestedBytes: 0, readBytes: 0,
        deliveredBytes: 0, closeAttempts: 0, closeFailures: 0, closeHandoffs: 0,
    };
    function beginSession(label, limit) {
        const session = {
            id: ++readSessionSeq, label, limit, handleId: null,
            order: [], // phase order proof: lstat -> open -> fstat -> read -> close
            fstatCalls: 0, readCalls: 0, readRequestedBytes: 0, readBytes: 0,
            delivered: 0, totalRead: 0, requests: [], requestsTruncated: false,
            close: null, error: null,
        };
        aggregate.sessions += 1;
        return session;
    }
    function endSession(session, primaryError) {
        session.error = primaryError ? `${primaryError.reason ?? 'io-failure'}: ${primaryError.message}` : null;
        lastReadBytes = session.totalRead;
        readSessionLog.push(session);
        if (readSessionLog.length > 64) readSessionLog.shift();
    }
    /** RP4: close a read-path handle with single-owner semantics. "Already closed" counts as
     * released; a genuine failure is handed SYNCHRONOUSLY to the one ledger owner (when bound)
     * and returned so the operation can never report success over it. */
    async function closeOwned(handle, session, which) {
        try {
            await handle.close();
            aggregate.closeAttempts += 1;
            session.order.push('close');
            return null;
        } catch (error) {
            aggregate.closeAttempts += 1;
            if (isAlreadyClosedError(error)) {
                session.order.push('close');
                return null;
            }
            aggregate.closeFailures += 1;
            if (onReadCloseFailure) {
                aggregate.closeHandoffs += 1;
                onReadCloseFailure({ transferId: `read-${session.id}:${which}`, stage: 'close', handle, label: which, error });
            }
            return error;
        }
    }
    /** RP4 shared core: read at most `limit` bytes (+1 growth sentinel) from the opened handle.
     * Every request asks for at most min(READ_CHUNK, limit+1-totalRead); REAL short reads keep
     * looping and only a 0-byte return ends the stream (never a busy loop). Overflow sentinel
     * bytes beyond the limit are never delivered to the sink. The sink is awaited per chunk, so
     * consumers get natural backpressure, and sink errors propagate (handles still close). */
    async function consumeBounded(handle, { limit, label, sink, session, refusalReason = 'corrupt-object' }) {
        const bound = limit + 1; // limit is validated above: +1 cannot overflow
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, bound));
        let total = 0;
        let delivered = 0;
        while (total < bound) {
            const request = Math.min(READ_CHUNK, bound - total);
            let got = 0;
            while (got < request) {
                const want = request - got;
                aggregate.readCalls += 1;
                session.readCalls += 1;
                session.readRequestedBytes += want;
                aggregate.readRequestedBytes += want;
                const { bytesRead } = await handle.read(buffer, got, want, total + got);
                session.requests.push({ request: want, got: bytesRead, cumulative: total + got + bytesRead });
                if (session.requests.length > REQUEST_TRACE_MAX) {
                    session.requestsTruncated = true;
                    session.requests.shift();
                }
                if (bytesRead === 0) break; // real EOF at this position
                aggregate.readBytes += bytesRead;
                session.readBytes += bytesRead;
                got += bytesRead;
            }
            total += got;
            const deliverable = Math.min(got, limit - delivered); // sentinel overflow never reaches the sink
            if (deliverable > 0) {
                await sink(buffer.subarray(0, deliverable));
                delivered += deliverable;
            }
            if (got < request) break; // EOF before the full request
        }
        session.totalRead = total;
        session.delivered = delivered;
        aggregate.deliveredBytes += delivered;
        if (total > limit) {
            throw Object.assign(Error(`${label}超过长度上限`), { reason: refusalReason });
        }
        return { totalRead: total, delivered };
    }
    /** RP4: bounded read of one file into a Buffer. lstat link refusal is kept; after the open a
     * handle.stat verifies regular-file + size (an initially oversized handle is refused with
     * ZERO content reads); a file truncated below the fstat size mid-read is refused instead of
     * trusting partial bytes. Business callers verify exact length and hash on the result. */
    async function readBoundedFile(file, { limit: rawLimit, label = '对象文件', refusalReason = 'corrupt-object' } = {}) {
        const limit = assertBoundedLimit(rawLimit, maxBytes, label, refusalReason);
        const session = beginSession(label, limit);
        lastReadBytes = 0;
        let primaryError;
        let handle = null;
        try {
            const linkStat = await fsp.lstat(file).catch(error => {
                if (error && error.code === 'ENOENT') return null;
                throw Object.assign(Error(`${label}不可读`), { reason: 'io-failure' });
            });
            if (linkStat && linkStat.isSymbolicLink()) {
                throw Object.assign(Error(`${label}路径是符号链接或 junction`), { reason: 'path-refused' });
            }
            if (!linkStat) throw Object.assign(Error(`${label}缺失`), { reason: refusalReason });
            if (!linkStat.isFile()) throw Object.assign(Error(`${label}不是普通文件`), { reason: refusalReason });
            if (linkStat.size > limit) {
                throw Object.assign(Error(`${label}大小超过上限`), { reason: refusalReason });
            }
            session.order.push('lstat');
            handle = await fsp.open(file, 'r');
            session.handleId = ++handleSeq;
            session.order.push('open');
            const st = await handle.stat();
            session.fstatCalls += 1;
            aggregate.fstatCalls += 1;
            session.order.push('fstat');
            if (!st.isFile()) throw Object.assign(Error(`${label}不是普通文件`), { reason: refusalReason });
            if (st.size > limit) {
                // The handle grew past its declaration between lstat and open: refused with
                // ZERO content reads (bounded by the fstat barrier, not by consuming bytes).
                throw Object.assign(Error(`${label}大小超过上限`), { reason: refusalReason });
            }
            const chunks = [];
            const result = await consumeBounded(handle, {
                limit, label, refusalReason, session,
                sink: chunk => { chunks.push(Buffer.from(chunk)); }, // copy: the core buffer is reused
            });
            session.order.push('read');
            if (result.totalRead < st.size) {
                throw Object.assign(Error(`${label}读取不完整（文件在读取期间被截断）`), { reason: refusalReason });
            }
            return Buffer.concat(chunks);
        } catch (error) {
            // Read/close I/O failures carry the frozen io-failure reason; core refusals that
            // already carry a stable reason (missing, oversize, overflow, path-refused) and any
            // caller-supplied reason pass through untouched.
            primaryError = error && error.reason ? error : Object.assign(
                Error(`${label}读取失败`),
                { reason: 'io-failure', cause: error });
            throw primaryError;
        } finally {
            const closeError = handle ? await closeOwned(handle, session, label) : null;
            session.close = handle ? (closeError ? { ok: false, error: closeError } : { ok: true }) : { ok: true, notOpened: true };
            endSession(session, primaryError);
            if (closeError) {
                if (primaryError) {
                    primaryError.closeError = closeError; // primary error preserved; close failure attached
                } else if (!onReadCloseFailure) {
                    throw closeError; // independent caller explicitly takes the resource over
                } else {
                    throw Object.assign(Error(`${label}句柄关闭失败，资源已移交清理账本`), { reason: 'io-failure', closeError });
                }
            }
        }
    }
    // F02: walk EVERY component from the real store root down; a junction/symlink or non-directory
    // anywhere along the chain (projects/<id>/objects) is refused before any read or write.
    async function walkTrusted(...parts) {
        let current = ensureRealRoot();
        for (const part of parts) {
            current = path.join(current, part);
            let stat = null;
            try { stat = await fsp.lstat(current); } catch { /* missing component */ }
            if (stat && stat.isSymbolicLink()) {
                throw Object.assign(Error('项目路径不允许符号链接或 junction'), { reason: 'path-refused' });
            }
            if (stat && !stat.isDirectory()) {
                throw Object.assign(Error('项目路径组件不是目录'), { reason: 'path-refused' });
            }
        }
        return current;
    }
    /** walkTrusted + creation of missing components + realpath containment proof afterwards. */
    async function ensureTrustedDir(...parts) {
        let current = ensureRealRoot();
        for (const part of parts) {
            current = path.join(current, part);
            let stat = null;
            try { stat = await fsp.lstat(current); } catch { /* missing component */ }
            if (stat && stat.isSymbolicLink()) {
                throw Object.assign(Error('项目路径不允许符号链接或 junction'), { reason: 'path-refused' });
            }
            if (stat && !stat.isDirectory()) {
                throw Object.assign(Error('项目路径组件不是目录'), { reason: 'path-refused' });
            }
            if (!stat) await fsp.mkdir(current);
        }
        const real = fsSync.realpathSync(current);
        if (real !== current && !real.startsWith(ensureRealRoot() + path.sep)) {
            throw Object.assign(Error('项目目录解析到存储根之外'), { reason: 'path-refused' });
        }
        return current;
    }
    return {
        root,
        sha256Hex,
        get _lastReadBytes() { return lastReadBytes; },
        /** RP4 (internal, not IPC): recent bounded-read session traces for evidence. */
        _readSessionLog: () => readSessionLog.slice(),
        /** RP4 (internal, not IPC): aggregate actual-I/O counters, separate from business budgets. */
        _readStats: () => ({ ...aggregate }),
        /** Test/lifecycle hook: the real resolved store root. */
        realRootPath: () => ensureRealRoot(),
        /** F02: shared guard for sibling stores (uploads dir); returns the trusted directory. */
        trustedSubdir: (...parts) => ensureTrustedDir(...parts),
        /** RP4 (internal): bounded read entry shared with the service (manifest, restore
         * verification, upload tmp) — same core, telemetry and close ownership as getObject. */
        readBoundedFile,

        /** Write canonical bytes, publish under <digest>.json; returns { digest, length }.
         * R2: an object that already exists under its digest name must prove its content — same
         * length alone is NOT enough; a tampered file is reported corrupt and never overwritten
         * or repaired. F02: every path component is walked and junctions/symlinks refused.
         * RP4: the existing-name proof is a bounded read (limit = the declared byte length,
         * +1 sentinel, fstat barrier, telemetry, close ownership). */
        async putObject(projectId, bytes) {
            const digest = sha256Hex(bytes);
            const dir = await ensureTrustedDir('projects', projectId, 'objects');
            const finalPath = path.join(dir, digest + OBJECT_EXT);
            let existingStat;
            try { existingStat = await fsp.lstat(finalPath); } catch { existingStat = null; }
            if (existingStat) {
                if (existingStat.isSymbolicLink()) {
                    throw Object.assign(Error('同名对象路径是符号链接或 junction'), { reason: 'path-refused' });
                }
                if (!existingStat.isFile()) {
                    throw Object.assign(Error('同名对象路径不是普通文件'), { reason: 'corrupt-object' });
                }
                if (existingStat.size !== bytes.length) {
                    // F05: refuse on the stat BEFORE reading a potentially huge tampered file.
                    throw Object.assign(Error('同名对象内容与摘要不符，已拒绝写入且不覆盖'), { reason: 'corrupt-object' });
                }
                // Immutable store: verify the existing bytes actually hash to the digest name.
                const existing = await readBoundedFile(finalPath, { limit: bytes.length, label: '同名对象' });
                if (existing.length !== bytes.length || sha256Hex(existing) !== digest) {
                    throw Object.assign(Error('同名对象内容与摘要不符，已拒绝写入且不覆盖'), { reason: 'corrupt-object' });
                }
                return { digest, length: bytes.length };
            }
            const tmpPath = path.join(dir, tmpName());
            let handle;
            try {
                handle = await call(faults.write, () => fsp.open(tmpPath, 'wx'));
                await handle.writeFile(bytes);
                await call(faults.sync, () => handle.sync());
                await call(faults.close, () => handle.close());
            } catch (error) {
                try { if (handle) await handle.close(); } catch { /* best effort */ }
                try { await fsp.unlink(tmpPath); } catch { /* best effort */ }
                throw error;
            }
            try {
                await call(faults.rename, () => fsp.rename(tmpPath, finalPath));
            } catch (error) {
                try { await fsp.unlink(tmpPath); } catch { /* best effort */ }
                throw error;
            }
            return { digest, length: bytes.length };
        },

        /** Read and verify one object; throws with a stable reason on missing/corrupt content.
         * F02: the whole directory chain is walked and junction/symlink indirection refused.
         * F05/RP4: the size is checked BEFORE reading (lstat, then the post-open handle.stat),
         * and the read is chunk-bounded by the declared length (+1 growth sentinel), so an
         * oversized or growing file is never fully buffered. The bytes actually read, every
         * request size and the close result are reported through the RP4 telemetry hooks. */
        async getObject(projectId, digest, expectedLength) {
            if (!/^[0-9a-f]{64}$/.test(digest)) throw Object.assign(Error('对象摘要无效'), { reason: 'corrupt-object' });
            const dir = await walkTrusted('projects', projectId, 'objects');
            const file = path.join(dir, digest + OBJECT_EXT);
            let bytes;
            try {
                bytes = await readBoundedFile(file, {
                    limit: expectedLength !== undefined ? expectedLength : undefined,
                    label: '登记的对象文件',
                });
            } catch (error) {
                if (error && error.reason === 'corrupt-object' && /缺失/.test(String(error.message))) {
                    throw Object.assign(Error('登记的对象文件缺失'), { reason: 'corrupt-object' });
                }
                throw error;
            }
            if (expectedLength !== undefined && bytes.length !== expectedLength) {
                throw Object.assign(Error('对象长度与登记值不符'), { reason: 'corrupt-object' });
            }
            if (sha256Hex(bytes) !== digest) throw Object.assign(Error('对象内容摘要不匹配'), { reason: 'corrupt-object' });
            return bytes;
        },

        /** Cheap existence+size map for every file in one project: { digest: {size} }, plus orphan count. */
        async listObjects(projectId) {
            const dir = await walkTrusted('projects', projectId, 'objects');
            const files = new Map();
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch (error) {
                if (error && error.code === 'ENOENT') return { files, orphans: 0 };
                throw error;
            }
            for (const entry of entries) {
                const match = /^([0-9a-f]{64})\.json$/.exec(entry);
                if (!match) continue;
                const full = path.join(dir, entry);
                let stat;
                try { stat = await fsp.lstat(full); } catch { continue; }
                if (stat.isSymbolicLink()) continue; // never follow or count links in the store
                files.set(match[1], stat.size);
            }
            let orphans = 0;
            for (const entry of entries) {
                if (!/^([0-9a-f]{64})\.json$/.test(entry) && !entry.startsWith('.tmp-')) orphans += 1;
            }
            return { files, orphans };
        },

        /** Full integrity check of one project against its registered snapshots (delegates every
         * content read to the bounded getObject core). */
        async verifyProject(projectId, snapshots) {
            const { files, orphans: orphanCount } = await this.listObjects(projectId);
            let missing = 0, corrupt = 0;
            let orphans = orphanCount;
            const registered = new Set();
            for (const snapshot of snapshots) {
                registered.add(snapshot.digest);
                const size = files.get(snapshot.digest);
                if (size === undefined) { missing += 1; continue; }
                try {
                    const bytes = await this.getObject(projectId, snapshot.digest, snapshot.length);
                    JSON.parse(bytes.toString('utf8'));
                } catch {
                    corrupt += 1;
                }
            }
            for (const digest of files.keys()) if (!registered.has(digest)) orphans += 1;
            return { objects: files.size, missing, corrupt, orphans };
        },

        /** Copy one verified object into another project directory (restore); both legs run on
         * the bounded core. */
        async copyObject(fromProject, toProject, digest, expectedLength) {
            const bytes = await this.getObject(fromProject, digest, expectedLength);
            return await this.putObject(toProject, bytes);
        },

        /** Stream one object of this store to an arbitrary file (backup), verifying length and
         * digest while streaming (R8: no full-buffer read of the object). F02: the source chain
         * is walked. RP4: the source is read through the bounded core — post-open handle.stat
         * (regular file + exact declared size, ZERO content reads on mismatch), requests of at
         * most min(64KiB, limit+1-total), real short-read looping, sentinel overflow never
         * written, and the destination sink is a partial-write loop with natural backpressure.
         * Any failure (including a close failure) removes THIS request's own destination and is
         * never published as success. */
        async streamObjectToFile(projectId, digest, expectedLength, destPath) {
            const limit = assertBoundedLimit(expectedLength, maxBytes, '对象', 'corrupt-object');
            const dir = await walkTrusted('projects', projectId, 'objects');
            const source = path.join(dir, digest + OBJECT_EXT);
            const linkStat = await fsp.lstat(source).catch(() => null);
            if (linkStat && linkStat.isSymbolicLink()) {
                throw Object.assign(Error('对象路径是符号链接或 junction'), { reason: 'path-refused' });
            }
            if (linkStat && linkStat.size !== expectedLength) {
                throw Object.assign(Error('对象大小与登记值不符'), { reason: 'corrupt-object' });
            }
            const session = beginSession('备份对象流式导出', limit);
            let sourceHandle = null;
            let destHandle = null;
            let destOpened = false;
            let primaryError;
            const hash = crypto.createHash('sha256');
            let seen = 0;
            try {
                sourceHandle = await fsp.open(source, 'r');
                session.handleId = ++handleSeq;
                session.order.push('open');
                const st = await sourceHandle.stat();
                session.fstatCalls += 1;
                aggregate.fstatCalls += 1;
                session.order.push('fstat');
                if (!st.isFile()) throw Object.assign(Error('对象不是普通文件'), { reason: 'corrupt-object' });
                if (st.size !== expectedLength) {
                    // Zero content reads when the handle does not match its declaration.
                    throw Object.assign(Error('对象大小与登记值不符'), { reason: 'corrupt-object' });
                }
                destHandle = await fsp.open(destPath, 'wx');
                destOpened = true;
                session.order.push('sink-open');
                await consumeBounded(sourceHandle, {
                    limit, label: '对象', refusalReason: 'corrupt-object', session,
                    sink: async chunk => {
                        await writeFully(destHandle, chunk); // partial-write loop; awaited: backpressure
                        hash.update(chunk);
                        seen += chunk.length;
                    },
                });
                session.order.push('read');
                if (seen !== expectedLength || hash.digest('hex') !== digest) {
                    throw Object.assign(Error('对象流式校验失败（长度或摘要）'), { reason: 'corrupt-object' });
                }
                return { digest, length: seen };
            } catch (error) {
                primaryError = error;
                try { if (destOpened) await fsp.rm(destPath, { force: true }); } catch { /* best effort */ }
                if (error && error.reason) throw error;
                throw Object.assign(Error('对象流式复制失败'), { reason: 'io-failure' });
            } finally {
                let closeError = sourceHandle ? await closeOwned(sourceHandle, session, '流式导出源') : null;
                const destCloseError = destHandle ? await closeOwned(destHandle, session, '流式导出目标') : null;
                if (destCloseError && !closeError) closeError = destCloseError;
                if (sourceHandle || destHandle) session.close = closeError ? { ok: false, error: closeError } : { ok: true };
                else session.close = { ok: true, notOpened: true };
                endSession(session, primaryError);
                if (closeError) {
                    if (primaryError) {
                        primaryError.closeError = closeError;
                    } else {
                        // A verified-looking export whose handle close failed is never published.
                        try { if (destOpened) await fsp.rm(destPath, { force: true }); } catch { /* best effort */ }
                        if (!onReadCloseFailure) throw closeError; // independent caller takes over
                        throw Object.assign(Error('对象流式导出句柄关闭失败，资源已移交清理账本'), { reason: 'io-failure', closeError });
                    }
                }
            }
        },

        /** Stream a verified backup file into this store as an object (restore), verifying length
         * and digest while streaming, then publishing through the same immutable path as
         * putObject (R8/R2: no full-buffer copy, existing objects must prove their content).
         * RP4: the source is read through the bounded core (handle.stat + 64KiB-capped requests
         * + sentinel), the tmp sink is a partial-write loop, and the existing-target proof is a
         * BOUNDED read instead of an unbounded readFile. A genuine close failure never publishes
         * and is handed to the single cleanup owner. */
        async streamFileToObject(sourcePath, projectId, expectedDigest, expectedLength) {
            const limit = assertBoundedLimit(expectedLength, maxBytes, '备份对象', 'corrupt-object');
            const dir = await ensureTrustedDir('projects', projectId, 'objects');
            const finalPath = path.join(dir, expectedDigest + OBJECT_EXT);
            const existingStat = await fsp.lstat(finalPath).catch(() => null);
            if (existingStat && existingStat.isSymbolicLink()) {
                throw Object.assign(Error('同名对象路径是符号链接或 junction'), { reason: 'path-refused' });
            }
            if (existingStat) {
                // Existing object must prove its content before the copy result is discarded.
                const existing = await readBoundedFile(finalPath, { limit, label: '同名对象' });
                if (existing.length !== expectedLength || sha256Hex(existing) !== expectedDigest) {
                    throw Object.assign(Error('同名对象内容与摘要不符，已拒绝写入且不覆盖'), { reason: 'corrupt-object' });
                }
                return { digest: expectedDigest, length: existing.length };
            }
            const session = beginSession('备份对象流式导入', limit);
            let sourceHandle = null;
            let tmpHandle = null;
            let tmpPath = null;
            let primaryError;
            const hash = crypto.createHash('sha256');
            let seen = 0;
            try {
                sourceHandle = await fsp.open(sourcePath, 'r');
                session.handleId = ++handleSeq;
                session.order.push('open');
                const st = await sourceHandle.stat();
                session.fstatCalls += 1;
                aggregate.fstatCalls += 1;
                session.order.push('fstat');
                if (!st.isFile()) throw Object.assign(Error('备份对象不是普通文件'), { reason: 'corrupt-object' });
                if (st.size !== expectedLength) {
                    // Zero content reads when the source does not match its declaration.
                    throw Object.assign(Error('备份对象大小与登记值不符'), { reason: 'corrupt-object' });
                }
                tmpPath = path.join(dir, tmpName());
                tmpHandle = await fsp.open(tmpPath, 'wx');
                session.order.push('sink-open');
                await consumeBounded(sourceHandle, {
                    limit, label: '备份对象', refusalReason: 'corrupt-object', session,
                    sink: async chunk => {
                        await writeFully(tmpHandle, chunk); // partial-write loop; awaited: backpressure
                        hash.update(chunk);
                        seen += chunk.length;
                    },
                });
                session.order.push('read');
                if (seen !== expectedLength || hash.digest('hex') !== expectedDigest) {
                    throw Object.assign(Error('备份对象流式校验失败（长度或摘要）'), { reason: 'corrupt-object' });
                }
                // Close the tmp write handle BEFORE publishing: a genuine close failure must not
                // be swallowed into a publish (single-owner handoff + tracked tmp removal).
                const tmpCloseError = await closeOwned(tmpHandle, session, '流式导入目标');
                tmpHandle = null;
                if (tmpCloseError) {
                    try { await fsp.rm(tmpPath, { force: true }); }
                    catch (rmError) {
                        if (onReadCloseFailure) {
                            onReadCloseFailure({ transferId: `read-${session.id}:流式导入tmp`, stage: 'rm', tmpPath, label: '流式导入tmp', error: rmError });
                        }
                    }
                    throw Object.assign(Error('备份对象临时文件句柄关闭失败，未发布'), { reason: 'io-failure', closeError: tmpCloseError });
                }
                try {
                    await fsp.rename(tmpPath, finalPath);
                } catch {
                    try { await fsp.rm(tmpPath, { force: true }); } catch { /* best effort */ }
                    throw Object.assign(Error('备份对象发布失败'), { reason: 'io-failure' });
                }
                return { digest: expectedDigest, length: seen };
            } catch (error) {
                primaryError = error;
                if (tmpPath) {
                    try { await fsp.rm(tmpPath, { force: true }); }
                    catch (rmError) {
                        if (onReadCloseFailure) {
                            onReadCloseFailure({ transferId: `read-${session.id}:流式导入tmp`, stage: 'rm', tmpPath, label: '流式导入tmp', error: rmError });
                        }
                    }
                }
                throw error;
            } finally {
                let closeError = sourceHandle ? await closeOwned(sourceHandle, session, '流式导入源') : null;
                if (tmpHandle) {
                    const lateTmpCloseError = await closeOwned(tmpHandle, session, '流式导入目标');
                    if (lateTmpCloseError && !closeError) closeError = lateTmpCloseError;
                }
                if (sourceHandle || tmpHandle) session.close = closeError ? { ok: false, error: closeError } : { ok: true };
                else if (!session.close) session.close = { ok: true };
                endSession(session, primaryError);
                if (closeError) {
                    if (primaryError) primaryError.closeError = closeError;
                    else if (!onReadCloseFailure) throw closeError; // independent caller takes over
                    else throw Object.assign(Error('备份对象流式导入句柄关闭失败，资源已移交清理账本'), { reason: 'io-failure', closeError });
                }
            }
        },

        /** Remove a whole project directory (restore rollback of a fresh, never-registered dir).
         * F02: the chain is walked first — a junctioned project dir is refused, never followed. */
        async removeProject(projectId) {
            const dir = await walkTrusted('projects', projectId);
            await fsp.rm(path.join(dir, 'objects'), { recursive: true, force: true });
        },
    };
}

module.exports = { createObjectStore, sha256Hex, projectDir };
