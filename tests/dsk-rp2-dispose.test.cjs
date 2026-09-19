// DSK-004-RP2: the awaitable, bounded, single-owner storage exit drain (dispose).
// CE1–CE3 are the named counterexamples: they run unchanged against the archived pre-fix
// snapshot via DSK_RP2_SERVICE_ENTRY (red run) and against the working tree normally (green).
// The counterexamples only use constructor DI the pre-fix source already understood (now, dialog,
// library), so a red run exercises the real old behavior — never a new-DI-shaped artifact.
// The fsp gate plugin intercepts node:fs/promises inside the esbuild bundle (same technique as
// the RP1 harness): gated rm calls still perform the REAL fs operation once released, and
// rmReject injections return a clearly marked SIMULATED rejection for exactly one picked path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = process.cwd();
// Red runs point DSK_RP2_SERVICE_ENTRY at the archived pre-fix snapshot under tmp/; normal runs
// use the working-tree implementation.
const SERVICE_ENTRY = process.env.DSK_RP2_SERVICE_ENTRY
    ? path.resolve(process.env.DSK_RP2_SERVICE_ENTRY)
    : path.join(repo, 'desktop', 'storage', 'service.cjs');

let bundleSeq = 0;
async function buildBundle(entry, { fspGate = false } = {}) {
    const outfile = path.join(repo, 'tmp', `dsk-rp2-dispose-bundle-${process.pid}-${bundleSeq++}.cjs`);
    await esbuild.build({
        entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
        charset: 'utf8', external: ['electron'], logLevel: 'silent',
        ...(fspGate ? { plugins: [fspGatePlugin()] } : {}),
    });
    process.on('exit', () => { try { fs.rmSync(outfile, { force: true }); } catch { /* best effort */ } });
    return require(outfile);
}

const contractsPromise = buildBundle(path.join(repo, 'shared', 'contracts', 'index.ts'), {}).then(mod => mod);
const libraryPromise = buildBundle(path.join(repo, 'desktop', 'storage', 'library.cjs'), {});
const objectsPromise = buildBundle(path.join(repo, 'desktop', 'storage', 'objects.cjs'), {});
const servicePromise = buildBundle(SERVICE_ENTRY, {});
const gatedServicePromise = buildBundle(SERVICE_ENTRY, { fspGate: true });

// RP2 fsp gate: rm gate (holds ONE matched call behind a real-timer gate) + rmReject (one
// SIMULATED rejection for exactly the test-picked path), a readFile gate (parks the matched
// read behind a real-timer gate so a handler can be held mid-flight across a dispose start)
// and a closeReject proxy (the matched fsp.open handle rejects close calls while armed, then
// performs the REAL close once disarmed). State is shared across the bundles of one build
// (service embeds objects/library) through globalThis, idempotently.
const RP2_FSP_WRAPPER = `
const real = require('fs/promises');
const state = globalThis.__rp2FspGates || {
    rmMatch: null, rmMatched: false, rmGate: null,
    rmRejectMatch: null, rmRejectCalls: 0, rmRejectPath: null, rmRejectCode: null, rmRejectError: null,
    rmScriptMatch: null, rmScript: null, rmScriptCalls: 0, rmParked: 0,
    readFileGateMatch: null, readFileGate: null,
    closeRejectMatch: null, closeRejectArmed: false, closeRejectActive: false, closeRejectCalls: 0,
    closeScript: null, closeGate: null, closeParked: 0,
};
globalThis.__rp2FspGates = state;
function simulatedDenial(kind, target) {
    const error = new Error('[rp2-fsp-gate] SIMULATED ' + kind + ' denial injected by the test (not a real OS permission failure): ' + target);
    error.code = 'EACCES';
    error.simulated = true;
    return error;
}
module.exports = {
    rm(...args) {
        // F1 script: per matched call consume one step — 'reject' denies once, 'pend' parks the
        // call behind rmGate until released (a genuinely hanging cleanup attempt).
        if (typeof state.rmScriptMatch === 'function' && state.rmScriptMatch(...args) && Array.isArray(state.rmScript) && state.rmScript.length) {
            state.rmScriptCalls += 1;
            const step = state.rmScript.shift();
            if (step === 'reject') {
                state.rmRejectCalls += 1;
                state.rmRejectPath = args[0];
                state.rmRejectError = simulatedDenial('fsp.rm', args[0]);
                return Promise.reject(state.rmRejectError);
            }
            if (step === 'pend') {
                state.rmParked += 1;
                return Promise.resolve(state.rmGate).then(() => real.rm(...args));
            }
        }
        if (typeof state.rmRejectMatch === 'function' && state.rmRejectMatch(...args)) {
            state.rmRejectCalls += 1;
            state.rmRejectPath = args[0];
            const error = new Error('[rp2-fsp-gate] SIMULATED fsp.rm denial injected by the test (not a real OS permission failure): ' + args[0]);
            error.code = state.rmRejectCode === 'EACCES' ? 'EACCES' : 'EPERM';
            error.simulated = true;
            state.rmRejectError = error;
            return Promise.reject(error);
        }
        if (typeof state.rmMatch === 'function' && !state.rmMatched && state.rmMatch(...args)) {
            state.rmMatched = true;
            if (state.rmGate) return state.rmGate.then(() => real.rm(...args));
        }
        return real.rm(...args);
    },
    async readFile(...args) {
        if (typeof state.readFileGateMatch === 'function' && state.readFileGateMatch(...args) && state.readFileGate) {
            await state.readFileGate;
        }
        return real.readFile(...args);
    },
    async open(...args) {
        const handle = await real.open(...args);
        if (state.closeRejectArmed && typeof state.closeRejectMatch === 'function' && state.closeRejectMatch(...args)) {
            state.closeRejectArmed = false; // exactly one matched handle is proxied
            return new Proxy(handle, {
                get(target, prop) {
                    if (prop === 'close') {
                        return async () => {
                            state.closeRejectCalls += 1;
                            // F1 script: 'reject' denies once, 'pend' parks behind closeGate.
                            if (Array.isArray(state.closeScript) && state.closeScript.length) {
                                const step = state.closeScript.shift();
                                if (step === 'reject') {
                                    const error = simulatedDenial('handle close', 'proxied .part handle');
                                    throw error;
                                }
                                if (step === 'pend') {
                                    state.closeParked += 1;
                                    await state.closeGate;
                                    return target.close();
                                }
                            }
                            if (state.closeRejectActive) {
                                const error = new Error('[rp2-fsp-gate] SIMULATED handle close denial injected by the test (not a real OS permission failure)');
                                error.code = 'EACCES';
                                error.simulated = true;
                                throw error;
                            }
                            return target.close();
                        };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }
        return handle;
    },
};
Object.setPrototypeOf(module.exports, real);
`;

function fspGatePlugin() {
    return {
        name: 'rp2-fsp-gate',
        setup(build) {
            build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'rp2-gated-fsp', namespace: 'rp2-fsp-gate' }));
            build.onLoad({ filter: /.*/, namespace: 'rp2-fsp-gate' }, () => ({ contents: RP2_FSP_WRAPPER, loader: 'js', resolveDir: repo }));
        },
    };
}

function gates() {
    return globalThis.__rp2FspGates;
}

let rootSeq = 0;
function freshRoot(label) {
    const root = path.join(repo, 'tmp', `dsk-rp2-dispose-${process.pid}-${label}-${rootSeq++}`);
    fs.rmSync(root, { recursive: true, force: true });
    return root;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** DB-open probe that works identically against the pre-fix and current _internal surface. */
function dbOpen(svc) {
    try { svc._internal.db.listProjects({ limit: 1 }); return true; } catch { return false; }
}

function verifiersFrom(contracts) {
    return { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema };
}

const FRAME = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };

/** CE1 (RP2 A1): frozen business clock + a request parked on a native dialog. The exit drain
 * must be bounded by an independent REAL timer: settle within the requested budget, report
 * blocked honestly and keep the database open. Pre-fix behavior: the drain deadline is derived
 * from the frozen business clock, so the loop never terminates while the request is parked —
 * dispose does not settle at all (unbounded wait) and never reports blocked. */
test('RP2 CE1 red: frozen business clock + pending dialog — dispose must settle blocked within a bounded real budget and keep the DB open', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await servicePromise;
    const root = freshRoot('ce1-frozen');
    let releaseDialog = () => { };
    const dialog = { showOpenDialog: () => new Promise(resolve => { releaseDialog = resolve; }) };
    const svc = createStorageService({
        root, dialog, now: () => 1700000000000, // frozen business clock
        verifiers: verifiersFrom(contracts),
    });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '冻结时钟' });
    assert.equal(created.ok, true);
    const pendingRestore = call('storage.v1.backup.restore', {}); // parks on the native dialog
    await sleep(60);
    assert.equal(svc.isBusy(), true, 'the dialog-pending restore must count as busy');
    let settled;
    try {
        settled = await Promise.race([
            svc.dispose({ timeoutMs: 400 }).then(value => ({ value })),
            sleep(1500).then(() => 'unsettled'),
        ]);
        assert.notEqual(settled, 'unsettled',
            'dispose 必须在有界真实时间内返回（原实现的截止时间来自被冻结的业务时钟，永远等不满，形成无界等待且从不返回 blocked）');
        assert.equal(settled.value && settled.value.ok, false,
            `dispose 必须如实返回 blocked，而不是无结果/成功：${JSON.stringify(settled.value)}`);
        assert.equal(settled.value && settled.value.blocked, 'timeout');
        assert.equal(dbOpen(svc), true, 'blocked 时项目库必须保持打开（pending 未清零禁止关库）');
    } finally {
        releaseDialog({ canceled: true, filePaths: [] }); // also un-wedges a red-run old dispose
    }
    await pendingRestore;
    // Controlled retry on the SAME original work: completes, closes the database exactly once.
    const retry = await svc.dispose();
    assert.equal(retry && retry.ok, true, `受控重试应成功：${JSON.stringify(retry)}`);
    assert.equal(dbOpen(svc), false, '重试成功后数据库才真正关闭');
});

/** CE2 (RP2 A1): accelerated business clock + a request still parked when the old business
 * deadline passes. Pre-fix behavior: the deadline expires in milliseconds of real time while
 * pendingOperations is still 1, the loop exits and db.close() runs anyway — a fake normal close
 * with the database closed underneath a live request. Required: blocked + DB kept open. */
test('RP2 CE2 red: accelerated business clock — dispose must not close the DB while a request is still pending', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await servicePromise;
    const root = freshRoot('ce2-fast');
    let releaseDialog = () => { };
    const dialog = { showOpenDialog: () => new Promise(resolve => { releaseDialog = resolve; }) };
    let clock = 1700000000000;
    const accelerator = setInterval(() => { clock += 1000; }, 5); // ~200× real time
    const svc = createStorageService({ root, dialog, now: () => clock, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '加速时钟' });
    assert.equal(created.ok, true);
    const pendingRestore = call('storage.v1.backup.restore', {});
    await sleep(60);
    assert.equal(svc.isBusy(), true);
    let result;
    try {
        result = await svc.dispose({ timeoutMs: 400 });
        assert.equal(result && result.ok, false,
            `仍有请求未完成时禁止伪报正常关闭（原实现在业务时限到达后直接关库并返回）：${JSON.stringify(result)}`);
        assert.equal(result && result.blocked, 'timeout');
        assert.equal(dbOpen(svc), true, 'pending>0 时数据库必须保持打开');
    } finally {
        clearInterval(accelerator);
        releaseDialog({ canceled: true, filePaths: [] });
    }
    await pendingRestore;
    const retry = await svc.dispose();
    assert.equal(retry && retry.ok, true, `受控重试应成功：${JSON.stringify(retry)}`);
    assert.equal(dbOpen(svc), false);
});

/** CE3 (RP2 A1): a cleanup that detached from the transfer map (sweeper timeout cancels
 * fire-and-forget; the tmp rm is still running behind a real-fs gate). Pre-fix behavior: dispose
 * sees zero sessions/zero pending handlers, closes the database and returns while the detached
 * cleanup is still in flight. Required: the drain tracks detached cleanups and reports blocked
 * until they settle. */
test('RP2 CE3 red: a detached transfer cleanup must hold the drain open and block a premature DB close', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('ce3-detached');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '脱离清理' });
    assert.equal(created.ok, true);
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const transferId = begin.data.transferId;
    const partPath = path.join(root, 'uploads', `${transferId}.part`);
    const gate = gates();
    gate.rmGate = new Promise(resolve => { gate.releaseRm = resolve; });
    gate.rmMatch = target => target === partPath;
    gate.rmMatched = false; // per-test arming: an earlier test's consumed gate must not leak
    try {
        // Fire-and-forget sweeper cancel: the transfer leaves the map, its rm parks on the gate.
        svc._internal.transfers.get(transferId).lastActivity = 0;
        svc._internal.sweepTransfers();
        await sleep(40);
        assert.equal(svc._internal.transfers.size, 0, 'the cancelled transfer must already be off the map');
        assert.equal(gate.rmMatched, true, 'the detached rm must have been reached');
        const settled = await Promise.race([
            svc.dispose({ timeoutMs: 350 }).then(value => ({ value })),
            sleep(1200).then(() => 'unsettled'),
        ]);
        assert.notEqual(settled, 'unsettled', 'dispose 必须在有界时间内返回');
        assert.equal(settled.value && settled.value.ok, false,
            `脱离 map 的后台清理未完成时禁止伪报成功/正常关闭：${JSON.stringify(settled.value)}`);
        assert.ok(settled.value && (settled.value.blocked === 'timeout' || settled.value.blocked === 'cleanup-failed'),
            `blocked 原因必须明确：${JSON.stringify(settled.value)}`);
        assert.equal(dbOpen(svc), true, '清理未完成时数据库必须保持打开');
    } finally {
        gate.releaseRm(); // the detached cleanup settles (real rm executes)
    }
    const retry = await svc.dispose();
    assert.equal(retry && retry.ok, true, `清理落地后受控重试应成功：${JSON.stringify(retry)}`);
    assert.equal(dbOpen(svc), false);
});

/** A2: concurrent and repeated dispose share ONE in-flight result; success closes the database
 * exactly once and is cached afterwards. */
test('RP2: repeated dispose shares one result, closes the DB exactly once and caches the closed state', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await servicePromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('close-once');
    const realLib = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let closeCount = 0;
    const library = { ...realLib, close() { closeCount += 1; realLib.close(); } };
    const svc = createStorageService({ root, library, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '仅关一次' });
    assert.equal(created.ok, true);
    const first = svc.dispose();
    const second = svc.dispose(); // joins the same in-flight drain
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.strictEqual(a, b, '并发 dispose 必须共享同一次结果');
    assert.equal(closeCount, 1, `成功关闭必须恰一次，实际 ${closeCount}`);
    const third = await svc.dispose();
    assert.strictEqual(third, a, '成功后的重复 dispose 返回缓存的关闭结果');
    assert.equal(closeCount, 1, '缓存结果不得再次关库');
    assert.equal(dbOpen(svc), false);
});

/** A2 (R2): a cleanup failure is reported blocked with the DB open, the failed resource stays
 * ACCOUNTED FOR (the .part file must not be silently written off), and a later dispose REALLY
 * retries the failed cleanup — only when it actually succeeds is the database closed. The old
 * behavior reset the error baseline per dispose call, so the retry skipped the leftover .part
 * entirely and closed the database over it. */
test('RP2: a failed cleanup reports blocked with the DB open; a later dispose really retries the failed cleanup before closing', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('cleanup-fail');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '清理失败' });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    const gate = gates();
    gate.rmRejectCode = 'EACCES';
    gate.rmRejectMatch = target => target === partPath;
    let blocked;
    try {
        blocked = await svc.dispose({ timeoutMs: 2000 });
    } finally {
        gate.rmRejectMatch = null;
        gate.rmRejectCode = null;
    }
    assert.equal(blocked.ok, false, `清理失败必须显式 blocked：${JSON.stringify(blocked)}`);
    assert.equal(blocked.blocked, 'cleanup-failed');
    assert.ok(gate.rmRejectCalls >= 1, 'the injected denial must have been reached');
    assert.equal(dbOpen(svc), true, '清理失败时数据库必须保持打开');
    assert.equal(fsSyncExists(partPath), true, '失败清理的资源必须仍在账上（.part 未删除，禁止当作已清理关库）');
    const retry = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(retry.ok, true, `重试必须真正重跑失败的清理后才能关库：${JSON.stringify(retry)}`);
    assert.ok(gate.rmRejectCalls >= 2, `重试必须真的再次尝试失败的 rm（实际 ${gate.rmRejectCalls} 次）`);
    assert.equal(fsSyncExists(partPath), false, '重试必须把遗留的 .part 真正清理掉');
    assert.equal(dbOpen(svc), false);
});

// Small sync existence probe (the test file intentionally keeps node:test + plain fs).
function fsSyncExists(target) {
    try { return fs.existsSync(target); } catch { return false; }
}

/** A2 (R2, the named red): a cleanup failure that keeps failing across dispose calls must keep
 * every later dispose blocked — a later call must NOT reset the error accounting and close the
 * database over a still-failing cleanup. Old behavior: the second dispose used a fresh error
 * baseline, saw no NEW errors and returned ok with the DB closed and the .part left behind. */
test('RP2: a persistently failing cleanup keeps every later dispose blocked (no baseline reset, no DB close over an unresolved resource)', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('cleanup-persistent');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '持续清理失败' });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    const gate = gates();
    gate.rmRejectCode = 'EACCES';
    gate.rmRejectMatch = target => target === partPath;
    try {
        const first = await svc.dispose({ timeoutMs: 900 });
        assert.equal(first.ok, false, `首轮清理失败必须 blocked：${JSON.stringify(first)}`);
        assert.equal(first.blocked, 'cleanup-failed');
        const second = await svc.dispose({ timeoutMs: 900 });
        assert.equal(second.ok, false, `故障未解除时第二次 dispose 不得重置账目后伪成功关库：${JSON.stringify(second)}`);
        assert.equal(second.blocked, 'cleanup-failed');
        assert.equal(dbOpen(svc), true, '清理未真正成功前数据库必须保持打开');
        assert.equal(fsSyncExists(partPath), true, '失败清理的 .part 必须保留在账上，不得抹除');
        assert.ok(second.unresolvedCleanups >= 1, `blocked 结果必须如实报告未解决清理数：${JSON.stringify(second)}`);
    } finally {
        gate.rmRejectMatch = null;
        gate.rmRejectCode = null;
    }
    // Fault removed: the SAME unresolved resource is retried for real, then the DB closes.
    const third = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(third.ok, true, `故障解除后真实重试清理应成功：${JSON.stringify(third)}`);
    assert.equal(fsSyncExists(partPath), false, '解除后重试必须真正删除遗留 .part');
    assert.equal(dbOpen(svc), false);
});

/** A2 (R2): a cleanup failure that happened BEFORE dispose (sweeper cancel) must not be
 * baseline-ignored by the drain — the DB stays blocked-open until the resource is really
 * cleaned. Old behavior: the pre-dispose error was below the per-dispose baseline, so dispose
 * closed the database over the leftover .part. */
test('RP2: a pre-dispose sweeper cleanup failure holds the drain blocked until the resource is really cleaned', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('cleanup-predispose');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '停机前清理失败' });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    const gate = gates();
    gate.rmRejectCode = 'EACCES';
    gate.rmRejectMatch = target => target === partPath;
    try {
        svc._internal.transfers.get(begin.data.transferId).lastActivity = 0;
        svc._internal.sweepTransfers(); // the cancel fires BEFORE dispose; its rm fails
        await sleep(60);
        assert.equal(svc._internal.transfers.size, 0);
        assert.ok(gate.rmRejectCalls >= 1, 'the pre-dispose rm denial must have been reached');
        const result = await svc.dispose({ timeoutMs: 900 });
        assert.equal(result.ok, false, `dispose 前的清理失败不得被基线忽略而伪成功：${JSON.stringify(result)}`);
        assert.equal(result.blocked, 'cleanup-failed');
        assert.equal(dbOpen(svc), true, '未解决清理存在时数据库必须保持打开');
        assert.equal(fsSyncExists(partPath), true);
    } finally {
        gate.rmRejectMatch = null;
        gate.rmRejectCode = null;
    }
    const retry = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(retry.ok, true, `故障解除后重试应真正清理并关库：${JSON.stringify(retry)}`);
    assert.equal(fsSyncExists(partPath), false);
    assert.equal(dbOpen(svc), false);
});

/** A2 (R2): a failing transfer HANDLE close is a distinct unresolved resource: it keeps the
 * drain blocked and is really retried (for actual close) before the DB closes. */
test('RP2: a failing transfer handle close blocks the drain and is really retried before the DB close', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('close-stage');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '句柄关闭失败' });
    // Arm BEFORE upload.begin: the gate proxies the very next .part handle opened by this service.
    const gate = gates();
    gate.closeRejectMatch = openedPath => String(openedPath).endsWith('.part'); // wrapper calls closeRejectMatch(path, flags)
    gate.closeRejectArmed = true;
    gate.closeRejectActive = true;
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    assert.ok(gate.closeRejectCalls === 0, 'the gate must not touch unrelated calls');
    try {
        const first = await svc.dispose({ timeoutMs: 900 });
        assert.equal(first.ok, false, `句柄关闭失败必须 blocked：${JSON.stringify(first)}`);
        assert.equal(first.blocked, 'cleanup-failed');
        assert.ok(gate.closeRejectCalls >= 1);
        assert.equal(dbOpen(svc), true, '句柄未真实关闭前数据库必须保持打开');
    } finally {
        gate.closeRejectActive = false; // subsequent close calls perform the REAL close
        gate.closeRejectMatch = null;   // per-test arming: never leak into later tests
    }
    const retry = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(retry.ok, true, `句柄真实关闭后重试应成功：${JSON.stringify(retry)}`);
    assert.ok(gate.closeRejectCalls >= 2, `重试必须真的再次尝试关闭句柄（实际 ${gate.closeRejectCalls} 次）`);
    assert.equal(fsSyncExists(partPath), false, '句柄关闭后遗留 .part 也必须清理');
    assert.equal(dbOpen(svc), false);
});

/** A2: a synchronous db.close() failure surfaces as blocked (never swallowed into a fake normal
 * close), the database stays open, and a retry fails honestly again without reopening. */
test('RP2: a throwing db.close reports blocked and keeps the DB open; retry fails honestly without reopening', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await servicePromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('close-fail');
    const realLib = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let closeCount = 0;
    const library = {
        ...realLib,
        close() {
            closeCount += 1;
            throw Error('注入：项目库关闭失败');
        },
    };
    const svc = createStorageService({ root, library, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '关库失败' });
    assert.equal(created.ok, true);
    const first = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(first.ok, false, `关库异常必须 blocked：${JSON.stringify(first)}`);
    assert.equal(first.blocked, 'db-close-failed');
    assert.equal(dbOpen(svc), true, '关库失败后数据库必须保持打开');
    const second = await svc.dispose({ timeoutMs: 2000 });
    assert.equal(second.ok, false, '重试必须如实再次报告失败');
    assert.equal(second.blocked, 'db-close-failed');
    assert.equal(closeCount, 2, '重试允许再次尝试关库，但绝不重开数据库');
    assert.equal(dbOpen(svc), true);
    realLib.close(); // test teardown
});

/** A1: dispose stops accepting requests and advances the frame generation SYNCHRONOUSLY, before
 * its first await — a handler dispatched in the same tick after dispose() must be refused. */
test('RP2: dispose stops the service synchronously (refuses requests, advances the generation) before any await', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await servicePromise;
    const root = freshRoot('sync-stop');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '同步停机' });
    assert.equal(created.ok, true);
    const generationBefore = svc._internal.frameGeneration();
    const draining = svc.dispose({ timeoutMs: 2000 });
    // Dispatched in the SAME tick as dispose (before any await): the generation has already
    // moved and the handler decision is already made; the promise only carries the answer.
    assert.ok(svc._internal.frameGeneration() > generationBefore, 'dispose 必须同步推进 RP1 frame generation');
    const refused = await call('project.status', { projectId: created.data.projectId });
    assert.equal(refused.ok, false, 'dispose 返回前新请求必须已被拒绝');
    assert.equal(refused.error.message, 'storage.v1/storage-unavailable');
    const result = await draining;    assert.equal(result.ok, true, `无未完成工作时 dispose 应成功：${JSON.stringify(result)}`);
    assert.equal(dbOpen(svc), false);
});

/** A1: cleanup work that the DRAIN ITSELF initiates is covered by the same bounded loop. A
 * commit parked on the gated readFile keeps a handler in flight across the dispose start;
 * closeSession (inside performDrain) then initiates the transfer cleanup AFTER dispose was
 * invoked, its rm parks on the gate, and the handler continuation fails honestly mid-wait.
 * Releasing the rm settles the cleanup during the wait and the SAME drain finishes without a
 * premature DB close. (Production cannot register a BRAND-NEW cleanup after dispose — the
 * synchronous stop refuses every entry point; what genuinely happens mid-wait is this
 * drain-initiated cleanup settling, and failing cleanups mid-wait are covered by the R2
 * ledger tests.) */
test('RP2: drain-initiated cleanup parks the loop and settles mid-wait — the same bounded drain finishes without a premature close', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const root = freshRoot('midwait-cleanup');
    const svc = createStorageService({ root, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '等待中清理' });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    // One chunk of 16 bytes that is NOT valid JSON: after the parked read is released the
    // commit continuation fails honestly into cancelTransfer mid-drain.
    await call('storage.v1.upload.chunk', { transferId: begin.data.transferId, offset: 0, data: Buffer.from('x'.repeat(16)).toString('base64') });
    const gate = gates();
    gate.readFileGateMatch = target => target === partPath;
    gate.readFileGate = new Promise(resolve => { gate.releaseRead = resolve; });
    gate.rmGate = new Promise(resolve => { gate.releaseRm = resolve; });
    gate.rmMatch = target => target === partPath;
    gate.rmMatched = false;
    try {
        const committing = call('storage.v1.upload.commit', { transferId: begin.data.transferId }); // parks at readFile
        await sleep(80);
        assert.equal(svc.pendingOperationCount(), 1, '挂起的 commit 必须计入 pending');
        const startedAt = Date.now();
        const draining = svc.dispose({ timeoutMs: 5000 });
        await sleep(200); // the drain is now waiting; closeSession has initiated the cleanup
        assert.equal(dbOpen(svc), true, '等待期间数据库必须保持打开');
        assert.equal(fsSyncExists(partPath), true, '挂起的 rm 尚未落地，.part 必须仍在');
        gate.releaseRead(); // the parked handler continuation fails honestly MID-WAIT
        const commit = await committing;
        assert.equal(commit.ok, false, '停服后的迟到提交必须如实失败');
        await sleep(120);
        assert.equal(dbOpen(svc), true, '处理器落地后清理仍挂起，数据库必须继续等待');
        assert.equal(fsSyncExists(partPath), true);
        gate.releaseRm(); // the drain-initiated cleanup settles mid-wait
        const result = await draining;
        const elapsed = Date.now() - startedAt;
        assert.equal(result.ok, true, `等待中的清理落地后同一轮排空应成功：${JSON.stringify(result)}`);
        assert.ok(elapsed < 4900, `排空必须在清理落地后有界返回（实际 ${elapsed}ms），不得等满预算`);
        assert.equal(fsSyncExists(partPath), false, '清理必须真正落地');
        assert.equal(dbOpen(svc), false);
    } finally {
        gate.releaseRead?.();
        gate.releaseRm?.();
    }
});

/** F1 (named red): the FIRST cleanup rm is denied, the RETRY attempt then HANGS. The drain must
 * start retries as observable non-blocking in-flight work — the overall real deadline still
 * bounds the wait (old behavior: performDrain awaited the hanging retry inline, so dispose hung
 * far past its budget and a second dispose joined the same never-settling promise). Blocked
 * must keep the resource accounted, start no further attempts after the deadline, never
 * duplicate concurrent attempts for the same resource across dispose calls, and close the DB
 * exactly once only after the hanging cleanup REALLY succeeds. Frozen business `now` proves the
 * real timers drive the budget independently. */
test('RP2 F1 red: a hanging cleanup RETRY must not make the drain unbounded — blocked in budget, no duplicate attempts, close only after real success', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('f1-rm-hang');
    const realLib = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let dbCloseCount = 0;
    const library = { ...realLib, close() { dbCloseCount += 1; realLib.close(); } };
    const svc = createStorageService({ root, library, dialog: null, verifiers: verifiersFrom(contracts), now: () => 1700000000000 });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: 'F1挂起重试rm' });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    const gate = gates();
    gate.rmScriptMatch = target => target === partPath;
    gate.rmScript = ['reject', 'pend']; // attempt #1 denies, attempt #2 hangs until released
    gate.rmGate = new Promise(resolve => { gate.releaseRm = resolve; });
    try {
        const startedAt = Date.now();
        const settled = await Promise.race([
            svc.dispose({ timeoutMs: 100 }).then(value => ({ value })),
            sleep(600).then(() => 'unsettled'),
        ]);
        const elapsed = Date.now() - startedAt;
        assert.notEqual(settled, 'unsettled', `挂起的重试不得使 dispose 无界等待（${elapsed}ms 未返回）`);
        assert.equal(settled.value && settled.value.ok, false, `超时必须如实 blocked：${JSON.stringify(settled.value)}`);
        assert.equal(settled.value && settled.value.blocked, 'cleanup-failed');
        assert.ok(elapsed < 900, `blocked 必须在真实预算附近返回（实际 ${elapsed}ms，预算 100ms）`);
        assert.ok(gate.rmParked >= 1, '重试必须确实进入挂起分支（故障已复现，非等待超时替代）');
        assert.equal(dbCloseCount, 0, '清理未完成禁止关库');
        assert.equal(fsSyncExists(partPath), true, '挂起重试的资源必须保留在账上');
        // A second dispose must NOT start another concurrent attempt for the SAME resource.
        const callsBefore = gate.rmScriptCalls;
        const settled2 = await Promise.race([
            svc.dispose({ timeoutMs: 100 }).then(value => ({ value })),
            sleep(600).then(() => 'unsettled'),
        ]);
        assert.notEqual(settled2, 'unsettled');
        assert.equal(settled2.value && settled2.value.ok, false);
        assert.equal(gate.rmScriptCalls, callsBefore, `跨 dispose 不得对同一资源重复并发启动清理（${callsBefore} → ${gate.rmScriptCalls}）`);
        assert.equal(dbCloseCount, 0);
    } finally {
        gate.rmScriptMatch = null;
        gate.rmScript = null;
        gate.releaseRm?.(); // failure-proof release: a parked attempt must never outlive the test
    }
    gate.releaseRm(); // the hanging attempt completes for REAL (the .part is actually removed)
    const third = await svc.dispose({ timeoutMs: 3000 });
    assert.equal(third.ok, true, `故障解除后重试应真正清理并关库：${JSON.stringify(third)}`);
    assert.equal(fsSyncExists(partPath), false, '释放后必须真正删除遗留 .part');
    assert.equal(dbCloseCount, 1, `数据库必须恰一次关闭：${dbCloseCount}`);
    assert.equal(dbOpen(svc), false);
});

/** F1 (named red): the same unbounded-retry defect through the transfer HANDLE close stage —
 * first close denied, retry attempt hangs. Same budget/dedupe/close-once requirements. */
test('RP2 F1 red: a hanging handle-close RETRY must not make the drain unbounded — blocked in budget, no duplicate attempts, close only after real success', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('f1-close-hang');
    const realLib = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let dbCloseCount = 0;
    const library = { ...realLib, close() { dbCloseCount += 1; realLib.close(); } };
    const svc = createStorageService({ root, library, dialog: null, verifiers: verifiersFrom(contracts), now: () => 1700000000000 });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const created = await call('project.create', { name: 'F1挂起重试close' });
    const gate = gates();
    gate.closeRejectMatch = openedPath => String(openedPath).endsWith('.part');
    gate.closeRejectArmed = true;
    gate.closeScript = ['reject', 'pend'];
    gate.closeGate = new Promise(resolve => { gate.releaseClose = resolve; });
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
    assert.equal(begin.ok, true, JSON.stringify(begin));
    const partPath = path.join(root, 'uploads', `${begin.data.transferId}.part`);
    try {
        const startedAt = Date.now();
        const settled = await Promise.race([
            svc.dispose({ timeoutMs: 100 }).then(value => ({ value })),
            sleep(600).then(() => 'unsettled'),
        ]);
        assert.notEqual(settled, 'unsettled', '挂起的句柄关闭重试不得使 dispose 无界等待');
        assert.equal(settled.value && settled.value.ok, false);
        assert.equal(settled.value && settled.value.blocked, 'cleanup-failed');
        assert.ok(gate.closeParked >= 1, '重试必须确实进入挂起分支');
        assert.equal(dbCloseCount, 0);
        const callsBefore = gate.closeRejectCalls;
        const settled2 = await Promise.race([
            svc.dispose({ timeoutMs: 100 }).then(value => ({ value })),
            sleep(600).then(() => 'unsettled'),
        ]);
        assert.notEqual(settled2, 'unsettled');
        assert.equal(gate.closeRejectCalls, callsBefore, '跨 dispose 不得对同一句柄重复并发启动关闭');
        assert.equal(dbCloseCount, 0);
    } finally {
        gate.closeRejectMatch = null;
        gate.closeRejectArmed = false;
        gate.closeScript = null;
        gate.releaseClose?.(); // failure-proof release: a parked attempt must never outlive the test
    }
    gate.releaseClose(); // the hanging close completes for REAL
    const third = await svc.dispose({ timeoutMs: 3000 });
    assert.equal(third.ok, true, `故障解除后重试应真正关闭句柄并关库：${JSON.stringify(third)}`);
    assert.equal(fsSyncExists(partPath), false);
    assert.equal(dbCloseCount, 1, `数据库必须恰一次关闭：${dbCloseCount}`);
});

/** Fallback consistency: the unavailable service answers the same dispose contract. */
test('RP2: the unavailable fallback service dispose resolves with a consistent success shape', async () => {
    const { createUnavailableStorageService } = await servicePromise;
    const unavailable = createUnavailableStorageService('schema-unsupported: RP2 测试');
    const result = await unavailable.dispose({ timeoutMs: 500 });
    assert.deepEqual(result, { ok: true });
    const bootstrap = await unavailable.handlers['storage.v1.session.bootstrap']({});
    assert.equal(bootstrap.ok, false);
});

/** RP3 A9: disposing while a PENDING initialization is parked, in three deterministic phases.
 * Phase 1: the drain-initiated closeFrameSessions cancels the pending upload — it leaves the
 * transfer map immediately, but its handler is still awaiting the initialization I/O, so the
 * drain must report blocked (timeout) with the database OPEN and db.close NEVER called.
 * Phase 2: the initialization settles (honest failure, handler done) but its DETACHED cleanup
 * rm is still parked behind the real fsp gate — the drain must STAY blocked with the DB open.
 * Phase 3: the cleanup really lands; a retry closes the database EXACTLY once (recorded by a
 * counting library wrapper) and a repeated dispose returns the cached success without closing
 * again — dbOpen false alone does not prove close-once, the counter does. All barriers use
 * entry/release signals (no timing guesses) and are failure-proof released in finally. Both
 * the pre-fix and current sources satisfy this (compat guard): the pending handler counts as
 * pendingOperations before RP3 as well. */
test('RP3 A9: dispose waits for a cancelled pending initialization (map empty, handler outstanding, then its detached cleanup), stays blocked with the DB open and db.close is called exactly once in total', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await gatedServicePromise;
    const { createObjectStore } = await objectsPromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('rp3-pending-init');
    const realStore = createObjectStore({ root });
    let releaseTrusted = null;
    let trustedParks = 0;
    let signalTrustedArrival = null;
    const trustedArrival = new Promise(resolve => { signalTrustedArrival = resolve; });
    const store = {
        ...realStore,
        async trustedSubdir(...args) {
            if (releaseTrusted === null && trustedParks === 0) {
                trustedParks += 1;
                signalTrustedArrival(); // entry signal: the initialization is parked from here on
                await new Promise(resolve => { releaseTrusted = resolve; });
            }
            return realStore.trustedSubdir(...args);
        },
    };
    const realLibrary = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let dbCloseCount = 0;
    const library = { ...realLibrary, close() { dbCloseCount += 1; realLibrary.close(); } };
    const svc = createStorageService({ root, objects: store, library, dialog: null, verifiers: verifiersFrom(contracts) });
    const call = (action, data) => svc.runInRequestContext(FRAME, () => svc.handlers[action](data));
    const gate = gates();
    let begin;
    try {
        const created = await call('project.create', { name: 'RP3挂起初始化' });
        assert.equal(created.ok, true);
        // Arm BEFORE the cancel: the FIRST .part rm parks behind rmGate (the detached cleanup).
        gate.rmMatched = false;
        gate.rmMatch = target => typeof target === 'string' && target.endsWith('.part');
        gate.rmGate = new Promise(resolve => { gate.releaseRm = resolve; });
        begin = call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: 16 });
        await trustedArrival; // deterministic: the initialization is parked now
        assert.equal(trustedParks, 1, 'the upload initialization must really be parked');
        assert.equal(svc._internal.transfers.size, 1, 'the pending initialization holds its transfer slot');
        assert.equal(svc.isBusy(), true, 'the parked initialization must count as busy');
        // Phase 1: the drain cancels the pending initialization (map empties synchronously)
        // but the handler is still parked — blocked with the DB open, close never called.
        const draining = svc.dispose({ timeoutMs: 300 });
        assert.equal(svc._internal.transfers.size, 0, 'the drain-initiated cancel must empty the map synchronously');
        assert.equal(dbOpen(svc), true, 'the in-flight handler keeps the database open');
        const blocked = await draining;
        assert.equal(blocked.ok, false, `dispose must stay blocked while the initialization is parked: ${JSON.stringify(blocked)}`);
        assert.equal(blocked.blocked, 'timeout');
        assert.equal(dbOpen(svc), true, 'a blocked dispose must keep the database open');
        assert.equal(dbCloseCount, 0, 'no blocked dispose may close the database');
        // Phase 2: the initialization settles (honest failure, handler DONE) while its detached
        // cleanup rm is still parked — the drain must STAY blocked with the DB open.
        releaseTrusted();
        const beginResult = await begin;
        assert.equal(beginResult.ok, false, 'the cancelled upload must fail honestly');
        assert.equal(svc.pendingOperationCount(), 0, 'the handler is done once the initialization settles');
        assert.ok(svc._internal.pendingCleanupCount() >= 1, 'the detached cleanup rm must still be parked');
        const blocked2 = await svc.dispose({ timeoutMs: 300 });
        assert.equal(blocked2.ok, false, `the outstanding detached cleanup must keep the drain blocked: ${JSON.stringify(blocked2)}`);
        assert.equal(blocked2.blocked, 'timeout');
        assert.equal(dbOpen(svc), true, 'the outstanding cleanup keeps the database open');
        assert.equal(dbCloseCount, 0, 'still no close while a cleanup is outstanding');
        // Phase 3: the cleanup really lands — the retry closes EXACTLY once.
        gate.releaseRm();
        const retry = await svc.dispose({ timeoutMs: 3000 });
        assert.equal(retry.ok, true, `受控重试应在初始化落地并清理后成功：${JSON.stringify(retry)}`);
        assert.equal(dbCloseCount, 1, `the database must close exactly once in total, got ${dbCloseCount}`);
        assert.equal(dbOpen(svc), false);
        // A repeated dispose returns the cached success and never closes again.
        const repeat = await svc.dispose({ timeoutMs: 1000 });
        assert.equal(repeat.ok, true, 'the repeated dispose returns the cached closed result');
        assert.equal(dbCloseCount, 1, 'the repeated dispose must never close again');
    } finally {
        releaseTrusted?.(); // failure-proof release: a parked initialization never outlives the test
        gate.releaseRm?.();  // failure-proof release: a parked cleanup never outlives the test
        gate.rmMatch = null;
        gate.rmGate = null;
        gate.rmMatched = false;
    }
    const uploadsDir = path.join(root, 'uploads');
    const leftovers = fsSyncExists(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    assert.deepEqual(leftovers, [], 'the cancelled pending initialization must not leave a .part file');
});
