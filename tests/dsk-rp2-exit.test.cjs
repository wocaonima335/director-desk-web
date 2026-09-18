// DSK-004-RP2 exit coordination tests (system Node, no Electron runtime).
// Loads the REAL desktop/main.cjs, desktop/files.cjs and desktop/updates.cjs with only the
// 'electron' module (and the NsisUpdater transport) replaced by controllable stubs, so the
// unified exit coordinator, the awaitable save confirmation and the real update wiring are
// exercised as wired — the fake updater never touches the network and never installs anything.
//
// CE4 is the named counterexample for files.cjs: via DSK_RP2_FILES_ENTRY it runs against the
// archived pre-fix snapshot and fails on the OLD behavior (the save receipt closes the window
// itself), never on a missing new API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const repo = process.cwd();
const FILES_ENTRY = process.env.DSK_RP2_FILES_ENTRY
    ? path.resolve(process.env.DSK_RP2_FILES_ENTRY)
    : path.join(repo, 'desktop', 'files.cjs');
// Ownership red/green lever (DSK-004-RP2-ownership-01): DSK_RP2_MAIN_ENTRY points the WHOLE
// coordinator suite at an archived pre-fix main.cjs snapshot (red run) — same trick as
// DSK_RP2_FILES_ENTRY. Unset = the working-tree implementation (green run).
const MAIN_ENTRY = process.env.DSK_RP2_MAIN_ENTRY
    ? path.resolve(process.env.DSK_RP2_MAIN_ENTRY)
    : path.join(repo, 'desktop', 'main.cjs');

// The REAL second-instance handler(s) registered by main.cjs at require time (the app-relaunch
// controlled-retry wiring). Recorded verbatim — the ownership tests fire THIS handler, not a
// nominal stand-in. When both the live module and an archived snapshot are loaded, the last
// registration wins, i.e. exactly the module under test.
const appListeners = {};

// R3 evidence upgrade: the update tests drive a REAL storage service (real sqlite, real
// dispose) instead of a prepareExit stub, so "closeDB strictly before quitAndInstall" is
// proven against the actual database close — the updater transport itself stays a labeled fake.
let bundleSeq = 0;
async function buildBundle(entry) {
    const outfile = path.join(repo, 'tmp', `dsk-rp2-exit-bundle-${process.pid}-${bundleSeq++}.cjs`);
    await esbuild.build({
        entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
        charset: 'utf8', external: ['electron'], logLevel: 'silent',
    });
    process.on('exit', () => { try { fs.rmSync(outfile, { force: true }); } catch { /* best effort */ } });
    return require(outfile);
}
const contractsPromise = buildBundle(path.join(repo, 'shared', 'contracts', 'index.ts'));
const servicePromise = buildBundle(path.join(repo, 'desktop', 'storage', 'service.cjs'));
const verifiersFrom = contracts => ({ document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema });
const realDbOpen = svc => {
    try { svc._internal.db.listProjects({ limit: 1 }); return true; } catch { return false; }
};

// --- controllable electron stub (one stable object; fixtures mutate its members) ------------
let currentCapture = null;
const electronStub = {
    app: {
        isPackaged: true,
        commandLine: { hasSwitch: () => false },
        setName() { }, setPath() { }, setAppUserModelId() { },
        requestSingleInstanceLock: () => true,
        whenReady: () => new Promise(() => { }), // createWindow never runs in tests
        on(name, fn) { appListeners[name] = fn; }, quit() { },
        getVersion: () => '1.0.0',
        getPath: () => os.tmpdir(),
    },
    ipcMain: {
        handle(name, fn) { if (currentCapture) currentCapture.handlers[name] = fn; },
        on(name, fn) { if (currentCapture) currentCapture.listeners[name] = fn; },
        removeHandler() { }, removeListener() { },
    },
    dialog: {
        showMessageBoxSync: () => 2,
        showMessageBox: async () => ({ response: 1 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
        showErrorBox() { },
    },
    protocol: { registerSchemesAsPrivileged() { }, handle() { } },
    BrowserWindow: class { },
    Menu: { setApplicationMenu() { } },
    shell: { openExternal: async () => { } },
    safeStorage: { isEncryptionAvailable: () => false },
    clipboard: { writeText() { } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === 'electron-updater/out/NsisUpdater') return { NsisUpdater: FakeUpdater };
    if (request === './integration.cjs') return { attachIntegration: () => ({ isBusy: () => false, prepareExit: async () => ({ ok: true }) }) };
    if (request === './updates.cjs') return { attachUpdates: () => ({ isQuitting: () => false }) };
    if (request === './files.cjs') return { attachFiles: () => ({ ready: Promise.resolve(), confirmExit: async () => 'cancelled', preventUnload: () => null }) };
    return originalLoad.apply(this, arguments);
};

// Fake updater transport: no network, no real installer. Only the surface touched by
// updates.cjs / update-host.cjs / update-provider.cjs is implemented. Instances are created
// inside attachUpdates, so the class tracks them statically for assertions. failMode injects
// SIMULATED installer failures ('throw-sync' | 'emit-error') to exercise the final-action
// arbitration — never a real installation.
class FakeUpdater {
    static instances = [];
    static onInstall = null;
    static failMode = null;
    static reset() { this.instances = []; this.onInstall = null; this.failMode = null; }
    static installCount() { return this.instances.reduce((sum, updater) => sum + updater.installs, 0); }
    static last() { return this.instances[this.instances.length - 1] ?? null; }
    constructor() { this.listeners = {}; this.installs = 0; this.installArgs = null; FakeUpdater.instances.push(this); }
    on(name, fn) { (this.listeners[name] ??= []).push(fn); return this; }
    once(name, fn) { return this.on(name, fn); }
    removeListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter(item => item !== fn); }
    removeAllListeners() { this.listeners = {}; }
    emit(name, arg) { for (const fn of [...(this.listeners[name] ?? [])]) fn(arg); }
    async checkForUpdates() { this.emit('update-available', { version: '9.9.9.9', releaseNotes: 'RP2 fixture' }); return { updateInfo: { version: '9.9.9.9' } }; }
    async downloadUpdate() { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded'); return []; }
    quitAndInstall(isSilent, isForce) {
        this.installs += 1; this.installArgs = [isSilent, isForce];
        if (FakeUpdater.onInstall) FakeUpdater.onInstall(this); // the attempt is observed (real dbOpen/drainState at this instant)
        if (FakeUpdater.failMode === 'throw-sync') {
            const error = new Error('[rp2-exit-test] SIMULATED installer crash injected by the test (quitAndInstall threw synchronously; nothing was installed)');
            error.simulated = true;
            throw error;
        }
        if (FakeUpdater.failMode === 'emit-error') {
            setImmediate(() => this.emit('error', Object.assign(Error('[rp2-exit-test] SIMULATED async updater error injected by the test'), { simulated: true })));
        }
    }
}

// Requiring main.cjs executes only its guarded startup; the coordinator factory is exported.
// MAIN_ENTRY is the working-tree implementation by default, or the archived pre-fix snapshot
// during the ownership red run — every coordinator fixture below exercises THAT module.
const { createExitCoordinator } = require(MAIN_ENTRY);
const filesMod = require(FILES_ENTRY);
const updatesMod = require('../desktop/updates.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForState(exit, predicate, label, timeoutMs = 2000) {
    for (let waited = 0; waited < timeoutMs; waited += 5) {
        const snapshot = exit.state();
        if (predicate(snapshot)) return snapshot;
        await sleep(5);
    }
    throw new Error(`等待状态超时（${label}）：最后状态 ${JSON.stringify(exit.state())}`);
}

// --- unified exit coordinator ------------------------------------------------------------
function coordinatorFixture({ confirm = 'discarded', prepareExit, blockedAnswer = 'retry', finalizeClose } = {}) {
    const log = [];
    const locks = [];
    const counts = { confirm: 0, drain: 0, blocked: 0, finalize: 0 };
    const blockedInfos = [];
    const answers = Array.isArray(blockedAnswer) ? [...blockedAnswer] : null;
    const exit = createExitCoordinator({
        confirmExit: async () => { counts.confirm += 1; log.push('confirm'); return typeof confirm === 'function' ? await confirm() : confirm; },
        prepareExit: async options => { counts.drain += 1; log.push('drain'); return typeof prepareExit === 'function' ? await prepareExit(options) : (prepareExit ?? { ok: true }); },
        showBlockedDialog: async info => {
            counts.blocked += 1; log.push('blocked'); blockedInfos.push(info);
            if (typeof blockedAnswer === 'function') return await blockedAnswer(counts.blocked, info);
            return answers ? answers.shift() : blockedAnswer;
        },
        setInteractionLocked: locked => { if (locks.at(-1) !== locked) locks.push(locked); }, // record CHANGES only: repeated lock re-assertion is not a release
        finalizeClose: () => { counts.finalize += 1; log.push('finalize'); if (finalizeClose) return finalizeClose(); },
    });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    return { exit, event, log, counts, locks, blockedInfos };
}

test('RP2 exit: cancelling the confirmation intercepts the close, keeps the window path open and never touches storage', async () => {
    const { exit, event, counts, log } = coordinatorFixture({ confirm: 'cancelled' });
    assert.equal(exit.handleClose(), true, '首次 close 必须被同步拦截');
    assert.equal(event.prevented, false, '拦截由调用方 preventDefault，协调器只报告决定');
    await waitForState(exit, state => state.state === 'OPEN', 'cancel back to OPEN');
    assert.deepEqual([counts.confirm, counts.drain, counts.finalize], [1, 0, 0], `取消后不得排空或关窗：${JSON.stringify(log)}`);
    // The window path must be usable again afterwards; a rapid second close during the first
    // flow folds into it (single owner), and after the cancel settles a fresh close re-confirms.
    const { exit: exit2, event: event2, counts: counts2 } = coordinatorFixture({ confirm: 'cancelled' });
    assert.equal(exit2.handleClose(), true);
    assert.equal(exit2.handleClose(), true, '进行中的退出流程必须拦截并发 close（并入同一流程）');
    await waitForState(exit2, state => state.state === 'OPEN', 'cancel back to OPEN');
    assert.equal(counts2.confirm, 1, '并入流程的 close 不得发起第二次确认');
    assert.equal(exit2.handleClose(), true, '取消后的再次 close 必须重新确认，不得放行');
    assert.equal(event2.prevented, false);
    await waitForState(exit2, state => state.state === 'OPEN', 'second cancel back to OPEN');
    assert.equal(counts2.confirm, 2);
});

test('RP2 exit: a confirmed exit drains once, then releases close/before-quit through the single final action', async () => {
    const { exit, counts, log, locks } = coordinatorFixture({ confirm: 'discarded' });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.quitReady === true, 'final release');
    assert.deepEqual(log, ['confirm', 'drain', 'finalize'], `成功路径顺序必须是确认→排空→唯一最终动作：${JSON.stringify(log)}`);
    assert.deepEqual([counts.drain, counts.finalize], [1, 1]);
    assert.deepEqual(locks, [true], '排空期间必须锁定窗口交互');
    assert.equal(exit.unloadAllowed(), true, 'READY 后 must-prevent-unload 放行');
    assert.equal(exit.handleClose(), false, 'READY 后再次 close 直接放行（唯一最终动作已执行）');
    assert.equal(exit.handleQuit(), false, 'READY 后 before-quit 放行');
    assert.equal(counts.finalize, 1, '不得出现第二个最终动作');
});

test('RP2 exit: close/app.quit/update reentry during one flow stays a single drain with a single final action; update gets no ownership', async () => {
    let releaseConfirm;
    const { exit, counts } = coordinatorFixture({
        confirm: () => new Promise(resolve => { releaseConfirm = resolve; }),
    });
    assert.equal(exit.handleClose(), true);
    assert.equal(exit.handleQuit(), true, '进行中的退出必须同步拦截 before-quit');
    assert.equal(await exit.prepareUpdateExit(), false, '另一入口已拥有退出流程时 update 不得取得所有权');
    assert.equal(counts.drain, 0, '未确认前不得开始排空');
    releaseConfirm('discarded');
    await waitForState(exit, state => state.quitReady === true, 'final release');
    assert.deepEqual([counts.confirm, counts.drain, counts.finalize], [1, 1, 1], `重入竞争必须只产生一次排空与一个最终动作：${JSON.stringify(counts)}`);
});

test('RP2 exit: a blocked drain shows the native blocked prompt; retry finishes the SAME drain and then finalizes once', async () => {
    let drainCalls = 0;
    const { exit, counts, log, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => {
            drainCalls += 1;
            return drainCalls === 1 ? { ok: false, blocked: 'timeout', detail: '超时注入' } : { ok: true };
        },
        blockedAnswer: 'retry',
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.quitReady === true, 'ready after retry');
    assert.deepEqual(log, ['confirm', 'drain', 'blocked', 'drain', 'finalize'], `blocked→原生提示→重试→唯一最终动作：${JSON.stringify(log)}`);
    assert.deepEqual([counts.blocked, counts.drain, counts.finalize], [1, 2, 1]);
    assert.deepEqual(locks, [true]);
});

test('RP2 exit: cancelling out of a blocked drain keeps BLOCKED locked (no fake recovery to OPEN) with a native retry entry', async () => {
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => ({ ok: false, blocked: 'timeout', detail: '超时注入' }),
        blockedAnswer: 'cancel',
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.state === 'BLOCKED', 'blocked cancel keeps the coordinator in BLOCKED');
    assert.deepEqual(locks, [true], '停服后受阻取消必须保持锁定（存储已停止，不得解锁回可编辑假象）');
    assert.deepEqual([counts.drain, counts.finalize], [1, 0]);
    assert.equal(exit.unloadAllowed(), false);
    // Native controlled retry entry: a close attempt in BLOCKED re-runs the SAME drain without
    // a second confirmation (the service is already stopped — the confirm belongs to the user's
    // document, which was already settled).
    assert.equal(exit.handleClose(), true, 'BLOCKED 下的 close 必须作为受控重试入口被拦截');
    await waitForState(exit, state => state.state === 'BLOCKED', 'retry against a still-failing drain');
    assert.equal(counts.confirm, 1, '受控重试不得对已确认过的用户重新弹确认');
    assert.equal(counts.drain, 2, '重试必须以新预算重跑同一排空');
    assert.equal(counts.blocked, 2, '仍受阻时必须重新给出原生受阻提示');
    assert.equal(counts.finalize, 0);
    assert.deepEqual(locks, [true]);
});

test('RP2 exit: the update entry reaches READY with ownership, then the installer owns the final action', async () => {
    const { exit, counts, log } = coordinatorFixture({ confirm: 'discarded' });
    assert.equal(await exit.prepareUpdateExit(), true, '取得 update 所有权且排空 READY 后才返回 true');
    assert.deepEqual([counts.confirm, counts.drain, counts.finalize], [1, 1, 0], `update 路径不得自行关窗（quitAndInstall 由安装器执行）：${JSON.stringify(log)}`);
    assert.equal(exit.state().quitReady, true, '安装重启触发的 close/before-quit 必须放行');
    assert.equal(exit.handleQuit(), false);
    assert.equal(exit.handleClose(), false);
});

test('RP2 exit: a blocked-cancelled exit retries to completion through the close entry without a second confirmation and finalizes exactly once', async () => {
    let drainCalls = 0;
    const { exit, counts, log, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => {
            drainCalls += 1;
            return drainCalls === 1 ? { ok: false, blocked: 'timeout', detail: '超时注入' } : { ok: true };
        },
        blockedAnswer: ['cancel', 'retry'],
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.state === 'BLOCKED', 'first blocked cancel');
    assert.deepEqual(locks, [true]);
    assert.equal(exit.handleClose(), true, 'BLOCKED 下的 close 是受控重试入口');
    await waitForState(exit, state => state.quitReady === true, 'retry reaches the final release');
    assert.deepEqual([counts.confirm, counts.drain, counts.finalize], [1, 2, 1],
        `重试成功路径不得重新确认、必须唯一最终动作：${JSON.stringify({ counts, log })}`);
    assert.deepEqual(locks, [true], '停服之后窗口始终保持锁定直到退出');
});

test('RP2 F2: a failing prepareExit surfaces the SAME native blocked prompt with an understandable reason, stays BLOCKED locked and the prompt retry recovers', async () => {
    let drainCalls = 0;
    const { exit, counts, locks, blockedInfos } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => {
            drainCalls += 1;
            if (drainCalls === 1) throw Error('注入：排空崩溃');
            return { ok: true };
        },
        blockedAnswer: 'retry',
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.quitReady === true, 'prompt retry recovers to the final release');
    assert.equal(counts.blocked, 1, `停服后排空异常必须出现原生受阻提示（旧实现为静默 BLOCKED，0 次提示）：${counts.blocked}`);
    assert.ok(blockedInfos[0] && String(blockedInfos[0].detail || blockedInfos[0].blocked).length > 0 && /内部|排空|错误/.test(JSON.stringify(blockedInfos[0])),
        `提示必须带可理解原因：${JSON.stringify(blockedInfos[0])}`);
    assert.deepEqual(locks, [true], '排空异常发生在停服之后，必须保持锁定，不得解锁回 OPEN');
    assert.equal(counts.finalize, 1);
    assert.equal(counts.confirm, 1, '提示重试不得重新确认');
});

// --- R3: final-action ownership arbitration ----------------------------------------------
// The single final action is authorized ONCE per attempt. A throwing window close or a failed
// installer restart must clear the erroneous authorization, keep the stopped-service
// protection (BLOCKED, locked), surface the SAME native blocked prompt and stay retryable.
test('RP2 F2: a throwing finalizeClose surfaces the native blocked prompt, clears the authorization, stays BLOCKED locked and the retry finalizes exactly once more', async () => {
    let finalizeCalls = 0;
    const { exit, counts, locks, blockedInfos } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => ({ ok: true }),
        blockedAnswer: 'retry',
        finalizeClose: () => {
            finalizeCalls += 1;
            if (finalizeCalls === 1) throw Error('注入：最终关窗失败');
        },
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.quitReady === true, 'prompt retry completes the final action');
    assert.equal(counts.blocked, 1, `最终关窗失败必须出现原生受阻提示（旧实现为静默 BLOCKED，0 次提示）：${counts.blocked}`);
    assert.ok(/最终|关窗|内部/.test(JSON.stringify(blockedInfos[0])), `提示必须带可理解原因：${JSON.stringify(blockedInfos[0])}`);
    assert.equal(exit.state().quitReady, true);
    assert.deepEqual(locks, [true], '停服后最终动作失败必须保持锁定');
    assert.equal(finalizeCalls, 2, `重试必须恰好再执行一次最终动作：${finalizeCalls}`);
    assert.equal(counts.confirm, 1);
});

test('RP2 F2: a throwing native blocked prompt is contained — no unhandled failure, stays BLOCKED locked, never releases and never loops', async () => {
    let promptCalls = 0;
    let throwing = true;
    let retries = 0;
    let drainCalls = 0;
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => {
            drainCalls += 1;
            if (drainCalls <= 2) return { ok: false, blocked: 'timeout', detail: '超时注入' };
            return { ok: true };
        },
        blockedAnswer: () => {
            promptCalls += 1;
            if (throwing) throw Error('注入：受阻提示自身崩溃');
            retries += 1;
            return retries === 1 ? 'retry' : 'cancel'; // strictly bounded answers: no unbounded retry loop
        },
        finalizeClose: () => { },
    });
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.state === 'BLOCKED', 'prompt failure stays BLOCKED');
    assert.ok(promptCalls >= 1);
    assert.equal(exit.state().quitReady, false, '提示崩溃不得放行退出');
    assert.deepEqual(locks, [true]);
    // The retry entry must remain usable once the prompt works again — bounded, no loop.
    throwing = false;
    assert.equal(exit.handleClose(), true);
    await waitForState(exit, state => state.quitReady === true, 'recovered prompt retry completes');
    assert.ok(counts.blocked <= 4, `提示不得无限循环（${counts.blocked} 次）`);
});

// --- files.cjs: awaitable save/exit confirmation ------------------------------------------
function filesFixture({ choiceProvider = () => 2 } = {}) {
    const dir = fs.mkdtempSync(path.join(repo, 'tmp', 'rp2-exit-files-'));
    const capture = { handlers: {}, listeners: {}, sent: [], dialogs: [], closeCalls: 0 };
    currentCapture = capture;
    electronStub.app.getPath = key => dir;
    electronStub.app.isPackaged = true;
    electronStub.dialog.showMessageBoxSync = (w, options) => { capture.dialogs.push(options); return choiceProvider(); };
    const listeners = {};
    const session = {
        setPermissionCheckHandler() { }, setPermissionRequestHandler() { },
        on(name, fn) { listeners['session:' + name] = fn; }, removeListener() { },
    };
    const window = {
        close() { capture.closeCalls += 1; },
        isDestroyed: () => false,
        setEnabled() { },
        webContents: {
            session,
            getURL: () => 'director://app/',
            send: (channel, data) => capture.sent.push({ channel, data }),
            on(name, fn) { listeners[name] = fn; },
        },
        on(name, fn) { listeners['window:' + name] = fn; },
    };
    const attached = filesMod.attachFiles(window);
    const trustedEvent = { sender: window.webContents, senderFrame: { url: 'director://app/' } };
    const fireCloseResult = (id, saved) => capture.listeners['director-save-close-result'](trustedEvent, { id, saved });
    return { attached, window, capture, listeners, trustedEvent, fireCloseResult, dir };
}

/** CE4 (RP2 A3): the save receipt must hand the close to the unified coordinator instead of
 * closing the window itself, and the confirmation must be awaitable. Pre-fix behavior: the
 * receipt calls window.close() directly. */
test('RP2 CE4 red: a successful save receipt must not close the window itself; the confirmation is awaitable', async () => {
    const fixture = filesFixture({ choiceProvider: () => 0 });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    fixture.attached.preventUnload(event); // navigation protection dialog, choice 保存并退出
    assert.equal(fixture.capture.sent.length, 1, '必须向 renderer 发出保存请求');
    const sentId = fixture.capture.sent[0].data.id;
    const pending = fixture.attached.confirmExit ? fixture.attached.confirmExit() : null;
    fixture.fireCloseResult(sentId, true);
    assert.equal(fixture.capture.closeCalls, 0,
        `保存回执不得自行关闭窗口（原实现回执里直接 window.close()）；关闭责任归统一退出协调器`);
    if (pending) assert.equal(await pending, 'saved', '确认必须可等待且以保存成功收尾');
});

test('RP2 files: cancelling the dialog or the save keeps the window and answers cancelled', async () => {
    const cancelled = filesFixture({ choiceProvider: () => 2 });
    assert.equal(await cancelled.attached.confirmExit(), 'cancelled');
    assert.deepEqual(cancelled.capture.sent, [], '取消不得发出保存请求');
    assert.equal(cancelled.capture.closeCalls, 0);
    assert.equal(cancelled.capture.dialogs.length, 1);
    assert.equal(cancelled.capture.dialogs[0].cancelId, 2, '三选确认的取消键必须是取消');
    assert.deepEqual(cancelled.capture.dialogs[0].buttons, ['保存并退出', '不保存退出', '取消']);

    const saveCancelled = filesFixture({ choiceProvider: () => 0 });
    const pending = saveCancelled.attached.confirmExit();
    assert.equal(saveCancelled.capture.sent.length, 1);
    saveCancelled.fireCloseResult(saveCancelled.capture.sent[0].data.id, false);
    assert.equal(await pending, 'cancelled', '保存取消/失败必须回到可继续编辑状态');
    assert.equal(saveCancelled.capture.closeCalls, 0);
});

test('RP2 files: repeat confirmations join one shared request; late stale receipts are refused', async () => {
    let choice = 0;
    const fixture = filesFixture({ choiceProvider: () => choice });
    const first = fixture.attached.confirmExit();
    const second = fixture.attached.confirmExit();
    assert.strictEqual(first, second, '进行中的确认必须共享同一次请求');
    assert.equal(fixture.capture.sent.length, 1, '共享确认只发出一次保存请求');
    assert.equal(fixture.capture.dialogs.length, 1, '共享确认只显示一次对话框');
    fixture.fireCloseResult(fixture.capture.sent[0].data.id, true);
    assert.equal(await first, 'saved');

    // A new confirmation gets a fresh id; the OLD receipt id must never resolve or trigger it.
    choice = 0;
    const third = fixture.attached.confirmExit();
    const freshId = fixture.capture.sent[fixture.capture.sent.length - 1].data.id;
    assert.notEqual(freshId, fixture.capture.sent[0].data.id, '新确认必须使用新请求 id');
    fixture.fireCloseResult(fixture.capture.sent[0].data.id, true); // late stale receipt
    const settled = await Promise.race([third.then(() => 'resolved'), sleep(150).then(() => 'pending')]);
    assert.equal(settled, 'pending', '延迟旧回执不得触发新退出');
    fixture.fireCloseResult(freshId, true);
    assert.equal(await third, 'saved');
    assert.equal(fixture.capture.closeCalls, 0, '整个确认过程 files 不得自行关窗');
});

test('RP2 files: navigation beforeunload protection keeps the synchronous dialog and routes save-exit through the shared confirmation', async () => {
    let choice = 1;
    const fixture = filesFixture({ choiceProvider: () => choice });
    const leave = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(fixture.attached.preventUnload(leave), null);
    assert.equal(leave.prevented, true, '不保存退出必须放行 unload（导航保护保持原语义）');
    const stay = { prevented: false, preventDefault() { this.prevented = true; } };
    choice = 2;
    assert.equal(fixture.attached.preventUnload(stay), null);
    assert.equal(stay.prevented, false, '取消必须保持 unload 被阻止');
    const saveExit = { prevented: false, preventDefault() { this.prevented = true; } };
    choice = 0;
    assert.equal(fixture.attached.preventUnload(saveExit), 'save-exit-requested');
    assert.equal(fixture.capture.sent.length, 1, '保存并退出必须发出共享保存请求');
    const pending = fixture.attached.confirmExit(); // joins the in-flight request, no second dialog
    assert.equal(fixture.capture.dialogs.length, 3);
    fixture.fireCloseResult(fixture.capture.sent[0].data.id, true);
    assert.equal(await pending, 'saved');
    assert.equal(fixture.capture.closeCalls, 0);

    // A reload starting mid-confirmation supersedes it: cancelled, window and storage stay.
    choice = 0;
    const reloadFixture = filesFixture({ choiceProvider: () => choice });
    const awaited = reloadFixture.attached.confirmExit();
    assert.equal(reloadFixture.capture.sent.length, 1);
    reloadFixture.listeners['did-start-loading']();
    assert.equal(await awaited, 'cancelled', '重新载入必须作废进行中的退出确认');
    assert.equal(reloadFixture.capture.closeCalls, 0);
});

// --- updates wiring: confirmInstall joins the unified exit before a synchronous install ----
class UpdateWindowStub {
    constructor(capture) {
        this.capture = capture;
        this.listeners = {};
        this.webContents = {
            session: { setPermissionCheckHandler() { }, setPermissionRequestHandler() { }, on() { }, removeListener() { } },
            getURL: () => 'director://app/',
            send: (channel, data) => this.capture.sent.push({ channel, data }),
            on: (name, fn) => { this.listeners[name] = fn; },
        };
    }
    close() { this.capture.closeCalls += 1; }
    isDestroyed() { return false; }
    on(name, fn) { this.listeners['window:' + name] = fn; }
}

function updateFixture({ confirmChoice = 1, blockedAnswer = 'cancel', drainTimeoutMs = 400, parkRestore = false, failMode = null } = {}) {
    const dir = fs.mkdtempSync(path.join(repo, 'tmp', 'rp2-exit-update-'));
    const capture = { handlers: {}, listeners: {}, sent: [], dialogs: [], blockedDialogs: 0, closeCalls: 0, log: [], drainCalls: 0 };
    currentCapture = capture;
    electronStub.app.getPath = key => (key === 'exe' ? path.join(dir, 'DirectorDesk.exe') : dir);
    electronStub.app.isPackaged = true;
    electronStub.dialog.showMessageBoxSync = (w, options) => { capture.dialogs.push(options); return confirmChoice; };
    electronStub.dialog.showMessageBox = async (w, options) => { capture.blockedDialogs += 1; capture.blockedOptions = options; return { response: blockedAnswer === 'retry' ? 0 : 1 }; };
    FakeUpdater.reset();
    FakeUpdater.failMode = failMode;
    // REAL storage service: prepareExit is the REAL dispose, so the install-side observation
    // proves the actual sqlite database was closed before quitAndInstall — not a stub claim.
    const storageRoot = path.join(dir, 'storage');
    fs.mkdirSync(storageRoot, { recursive: true });
    const svcReady = Promise.all([contractsPromise, servicePromise]).then(([contracts, { createStorageService }]) => {
        const svc = createStorageService({
            root: storageRoot,
            verifiers: verifiersFrom(contracts),
            dialog: parkRestore ? { showOpenDialog: () => new Promise(() => { }) } : null,
        });
        return svc;
    });
    let svc = null;
    FakeUpdater.onInstall = () => {
        capture.log.push('install');
        capture.dbOpenAtInstall = svc ? realDbOpen(svc) : null;
        capture.drainStateAtInstall = svc ? svc._internal.drainState() : null;
    };
    const exit = createExitCoordinator({
        confirmExit: async () => 'discarded', // the update path brings its own confirm dialog
        prepareExit: async options => {
            capture.drainCalls += 1; capture.log.push('drain');
            svc ??= await svcReady;
            return svc.dispose(options);
        },
        showBlockedDialog: async info => { capture.blockedDialogs += 1; capture.blockedOptions = info; capture.blockedInfos = capture.blockedInfos || []; capture.blockedInfos.push(info); return blockedAnswer; },
        setInteractionLocked() { },
        finalizeClose() { capture.log.push('finalize'); },
        drainTimeoutMs,
    });
    const window = new UpdateWindowStub(capture);
    updatesMod.attachUpdates(window, { isBusy: () => false }, exit);
    const handler = capture.handlers['director-updates'];
    assert.ok(handler, 'attachUpdates 必须注册 director-updates 处理器');
    const trustedEvent = { sender: window.webContents, senderFrame: { url: 'director://app/' } };
    const cleanup = async () => {
        if (window.listeners['window:closed']) window.listeners['window:closed']();
        // Teardown: a service the test left stopped-and-open (parked handler, blocked path) must
        // still release the real sqlite handle so the test process can exit.
        if (svc && realDbOpen(svc)) { try { svc._internal.db.close(); } catch { /* best effort */ } }
    };
    return { capture, handler, trustedEvent, cleanup, exit, window, ensureSvc: async () => { svc ??= await svcReady; return svc; } };
}

async function prepareDownloadedUpdate(fixture) {
    const saved = await fixture.handler(fixture.trustedEvent, { action: 'save', data: { url: 'https://updates.example/files', automatic: true } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const checked = await fixture.handler(fixture.trustedEvent, { action: 'check' });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.data.phase, 'available', `模拟检查必须发现新版本：${JSON.stringify(checked.data)}`);
    const downloaded = await fixture.handler(fixture.trustedEvent, { action: 'download' });
    assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
    assert.equal(downloaded.data.phase, 'downloaded');
}

test('RP2 updates: a confirmed install joins the unified exit — the REAL database is closed strictly before quitAndInstall, exactly once', async () => {
    const fixture = updateFixture({ confirmChoice: 1 });
    try {
        await prepareDownloadedUpdate(fixture);
        const install = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(install.ok, true, JSON.stringify(install));
        assert.equal(FakeUpdater.installCount(), 1, 'quitAndInstall 必须恰一次');
        assert.deepEqual(FakeUpdater.last().installArgs, [false, true]);
        assert.deepEqual(fixture.capture.log, ['drain', 'install'], `关库（排空完成）必须严格先于安装：${JSON.stringify(fixture.capture.log)}`);
        assert.equal(fixture.capture.drainCalls, 1);
        assert.equal(fixture.capture.dbOpenAtInstall, false, 'quitAndInstall 执行时真实 sqlite 必须已关闭（实际 dbOpen 证据）');
        assert.equal(fixture.capture.drainStateAtInstall, 'ready', '安装时排空必须处于 ready');
        // Authorization is single-shot: a second attempt while installing is refused.
        const second = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(second.ok, false, 'install 进行中不得再次授权');
        assert.equal(FakeUpdater.installCount(), 1);
    } finally { await fixture.cleanup(); }
});

test('RP2 updates: cancelling the confirm dialog keeps phase downloaded with zero installs and zero drains', async () => {
    const fixture = updateFixture({ confirmChoice: 0 });
    try {
        await prepareDownloadedUpdate(fixture);
        const result = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.data.phase, 'downloaded', '取消后停留在已下载状态');
        assert.equal(fixture.capture.drainCalls, 0, '确认取消不得启动存储排空');
        assert.equal(FakeUpdater.installCount(), 0, '取消安装必须为零安装');
    } finally { await fixture.cleanup(); }
});

test('RP2 updates: a REAL blocked drain (parked in-flight restore) means zero installs — the native blocked prompt appears and nothing is installed', async () => {
    const fixture = updateFixture({ confirmChoice: 1, blockedAnswer: 'cancel', drainTimeoutMs: 400, parkRestore: true });
    try {
        // Park a REAL storage handler on the (hung) directory picker so the drain cannot finish.
        const svc = await fixture.ensureSvc();
        const frame = { sender: fixture.window.webContents, senderFrame: { url: 'director://app/' } };
        void svc.runInRequestContext(frame, () => svc.handlers['storage.v1.backup.restore']({}));
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(realDbOpen(svc), true, '受阻场景进入安装前数据库必须还在打开（未完成排空）');
        await prepareDownloadedUpdate(fixture);
        const result = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(result.ok, true, `update-host 将受阻如实上报为未安装：${JSON.stringify(result)}`);
        assert.equal(result.data.phase, 'downloaded', '受阻后不得进入安装状态');
        assert.equal(FakeUpdater.installCount(), 0, '超时/受阻安装必须为零安装');
        assert.equal(fixture.capture.log.includes('install'), false);
        assert.ok(fixture.capture.blockedDialogs >= 1, '受阻必须出现原生受阻提示');
        assert.equal(fixture.capture.drainCalls, 1, '受阻路径尝试过一轮真实排空');
    } finally { await fixture.cleanup(); }
});

// --- R3: installer failures clear the erroneous authorization, keep the protection and stay retryable
test('RP2 updates: a synchronously throwing quitAndInstall clears the authorization, keeps BLOCKED and the close entry retries as a normal exit', async () => {
    const fixture = updateFixture({ confirmChoice: 1, failMode: 'throw-sync' });
    try {
        await prepareDownloadedUpdate(fixture);
        const install = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(install.ok, true, JSON.stringify(install));
        assert.equal(install.data.phase, 'error', 'update-host 必须如实上报模拟安装崩溃');
        assert.equal(FakeUpdater.installCount(), 1, 'quitAndInstall 尝试恰一次，且未真实安装任何东西');
        await waitForState(fixture.exit, state => state.state === 'BLOCKED', 'installer failure lands in BLOCKED');
        assert.equal(fixture.exit.state().quitReady, false, '安装失败必须清除放行授权，不得永远停留在 FINALIZING/ready');
        assert.ok(fixture.capture.blockedDialogs >= 1, `安装同步崩溃必须出现原生受阻提示（旧实现为静默 BLOCKED，0 次提示）：${fixture.capture.blockedDialogs}`);
        assert.ok(/安装|更新/.test(JSON.stringify(fixture.capture.blockedOptions)), `提示必须带可理解原因：${JSON.stringify(fixture.capture.blockedOptions)}`);
        assert.equal(fixture.capture.log.includes('finalize'), false, '安装失败不得触发关窗最终动作');
        // One grant, one attempt: after the simulated crash the updater phase is 'error', so a
        // new install attempt is refused by the host without a second ownership grant.
        const second = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(second.ok, false, `失败后不得再次授权安装：${JSON.stringify(second)}`);
        assert.equal(FakeUpdater.installCount(), 1, 'BLOCKED 期间不得再次授权安装');
        // Native controlled retry: a close attempt re-owns the final action as a NORMAL exit.
        assert.equal(fixture.exit.handleClose(), true, 'BLOCKED 下的 close 必须是受控重试入口');
        await waitForState(fixture.exit, state => state.quitReady === true, 'retry completes the normal exit');
        assert.deepEqual(fixture.capture.log, ['drain', 'install', 'drain', 'finalize'],
            `安装失败后的重试降级为正常关窗退出（不重跑安装）：${JSON.stringify(fixture.capture.log)}`);
    } finally { await fixture.cleanup(); }
});

test('RP2 updates: an asynchronous updater error after authorization also clears the authorization and lands in BLOCKED', async () => {
    const fixture = updateFixture({ confirmChoice: 1, failMode: 'emit-error' });
    try {
        await prepareDownloadedUpdate(fixture);
        const install = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(install.ok, true, JSON.stringify(install));
        assert.equal(FakeUpdater.installCount(), 1);
        await waitForState(fixture.exit, state => state.state === 'BLOCKED', 'async updater error lands in BLOCKED');
        assert.equal(fixture.exit.state().quitReady, false, '异步安装失败同样必须清除放行授权');
        assert.ok(fixture.capture.blockedDialogs >= 1, `异步安装失败必须出现原生受阻提示（旧实现为静默 BLOCKED，0 次提示）：${fixture.capture.blockedDialogs}`);
        assert.equal(fixture.capture.log.includes('finalize'), false);
        assert.equal(fixture.exit.handleClose(), true);
        await waitForState(fixture.exit, state => state.quitReady === true, 'retry completes the normal exit');
        assert.deepEqual(fixture.capture.log, ['drain', 'install', 'drain', 'finalize'],
            `异步失败后的重试降级为正常关窗退出：${JSON.stringify(fixture.capture.log)}`);
    } finally { await fixture.cleanup(); }
});

test('RP2 F2: a LATE duplicate updater error must not revoke the new owner authorization nor re-prompt after the retry re-owns the exit', async () => {
    const fixture = updateFixture({ confirmChoice: 1, failMode: 'throw-sync' });
    try {
        await prepareDownloadedUpdate(fixture);
        const install = await fixture.handler(fixture.trustedEvent, { action: 'install' });
        assert.equal(install.data.phase, 'error', JSON.stringify(install));
        await waitForState(fixture.exit, state => state.state === 'BLOCKED', 'installer failure lands in BLOCKED');
        const promptsAfterLanding = fixture.capture.blockedDialogs;
        assert.ok(promptsAfterLanding >= 1);
        // Retry re-owns the final action as a NORMAL close (new authorization, finalKind 'close').
        assert.equal(fixture.exit.handleClose(), true);
        await waitForState(fixture.exit, state => state.quitReady === true, 'retry completes the normal exit');
        // A LATE stale error from the old failing updater attempt arrives now.
        FakeUpdater.last().emit('error', Object.assign(Error('[rp2-exit-test] LATE stale updater error'), { simulated: true }));
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(fixture.exit.state().quitReady, true, '迟到旧回调不得撤销新 owner 的放行授权');
        assert.equal(fixture.exit.state().state, 'FINALIZING', '迟到旧回调不得把已完成的重试拉回 BLOCKED');
        assert.equal(fixture.capture.blockedDialogs, promptsAfterLanding, '迟到旧回调不得重复弹出受阻提示');
    } finally { await fixture.cleanup(); }
});

test('RP2 F2: a close attempt while the blocked prompt is pending must not start a second concurrent retry (single prompt/retry owner)', async () => {
    let drainCalls = 0;
    let releasePrompt;
    const promptGate = new Promise(resolve => { releasePrompt = resolve; });
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => { drainCalls += 1; throw Error('注入：排空崩溃'); },
        blockedAnswer: async () => { await promptGate; return 'cancel'; },
    });
    assert.equal(exit.handleClose(), true);
    // The exception landing shows the native prompt and waits for the user (still pending):
    // while the prompt is up the flow stays DRAINING (locked); BLOCKED is the post-cancel state.
    for (let waited = 0; waited < 2000 && counts.blocked === 0; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(counts.blocked, 1, '排空异常必须出现原生受阻提示');
    assert.equal(exit.state().state, 'DRAINING', '提示挂起期间流程处于 DRAINING 等待用户决定');
    assert.equal(drainCalls, 1);
    // A close attempt while the prompt owns the decision must stay intercepted WITHOUT
    // starting a second concurrent retry behind the user's back.
    assert.equal(exit.handleClose(), true, '提示挂起期间的 close 仍须被拦截');
    assert.equal(exit.handleQuit(), true);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(drainCalls, 1, `提示挂起期间不得有第二个并发重试 owner（drain ${drainCalls} 次）`);
    assert.equal(counts.blocked, 1, '竞争不得重复弹出提示');
    assert.deepEqual(locks, [true]);
    // Answering cancel keeps BLOCKED; the retry entry then works normally.
    releasePrompt();
    await waitForState(exit, state => state.state === 'BLOCKED', 'cancel keeps BLOCKED');
    assert.equal(exit.state().quitReady, false);
    assert.deepEqual(locks, [true]);
});

// --- F3/F4 ownership (DSK-004-RP2-ownership-01) --------------------------------------------
// F3: while the ONE owned blocked notice is pending, the external entries (window close,
// app quit, and the REAL registered second-instance handler = app relaunch) must only be
// refused — never start or backlog an exit attempt behind the user's pending decision; the
// notice's own answer is the at-most-one retry decision, consumed exactly once afterwards.
// F4: consecutive failures must each honor their '继续等待' answer — the second retry must
// never be dropped because an internal retry flag was still set (no recursive retry).
//
// RED-RUN NOTE (honest scoping): on the archived pre-fix snapshot the module-level
// exitCoordinator binding is only set by createWindow, which never runs under node:test, so
// the fired real handler no-ops there and the wiring half below is red for that wiring reason.
// The unauthorized-start half therefore ALSO drives the exact coordinator entry the handler
// routes to (exit.retryBlockedExit — the very export the product handler calls), which exists
// and is live on the snapshot, so the red failure is the behavioral one (counts/越权), never a
// missing-new-API error.
test('RP2 F3: while the finalize-failure notice is pending, mixed close/quit/second-instance triggers start nothing behind the decision and the retry answer is consumed exactly once', async () => {
    let finalizeCalls = 0;
    let releaseNotice;
    const noticeGate = new Promise(resolve => { releaseNotice = resolve; });
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => ({ ok: true }),
        finalizeClose: () => { finalizeCalls += 1; if (finalizeCalls === 1) throw Error('注入：最终关窗失败'); },
        blockedAnswer: async () => { await noticeGate; return 'retry'; }, // the pending user decision
    });
    try {
        assert.equal(exit.handleClose(), true);
        await waitForState(exit, state => state.state === 'BLOCKED', 'finalize failure lands BLOCKED with the owned notice pending');
        assert.equal(finalizeCalls, 1);
        const secondInstance = appListeners['second-instance'];
        assert.equal(typeof secondInstance, 'function', 'main.cjs 必须真实注册 second-instance 处理器（应用重启是受控重试入口）');
        // Mixed triggers while the notice owns the decision: the REAL registered handler, the
        // window close entry, the app-quit entry and the exact retry export the handler uses.
        secondInstance();
        assert.equal(exit.handleClose(), true, '提示挂起期间 close 仍须被拦截');
        assert.equal(exit.handleQuit(), true, '提示挂起期间 before-quit 仍须被拦截');
        exit.retryBlockedExit();
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(counts.drain, 1, `提示挂起期间不得在用户决定背后启动第二个退出尝试（drain ${counts.drain} 次）`);
        assert.equal(finalizeCalls, 1, `提示挂起期间不得有第二个最终动作（finalize ${finalizeCalls} 次）`);
        assert.equal(counts.blocked, 1, '竞争触发不得重复弹出提示，也不得积压新的提示');
        // The user answers 继续等待 → consumed EXACTLY once: one more drain + one more finalize.
        releaseNotice();
        await waitForState(exit, state => state.quitReady === true, 'the pending notice retry answer completes the exit', 4000);
        assert.deepEqual([counts.drain, finalizeCalls], [2, 2], `答复 retry 后必须恰好追加一次排空与最终动作：${JSON.stringify({ counts, finalizeCalls })}`);
        assert.equal(counts.confirm, 1, '提示重试不得重新确认');
        assert.deepEqual(locks, [true]);
    } finally {
        releaseNotice(); // bounded: always release the self-built pending gate (no OOM/hang)
    }
});

test('RP2 F3: the REAL registered second-instance handler is itself the controlled retry entry — in BLOCKED (no notice pending) firing it starts exactly one retry', async () => {
    let drainCalls = 0;
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => {
            drainCalls += 1;
            return drainCalls === 1 ? { ok: false, blocked: 'timeout', detail: '超时注入' } : { ok: true };
        },
        blockedAnswer: 'cancel', // bounded: the first notice is answered cancel, the retry then drains clean
    });
    try {
        assert.equal(exit.handleClose(), true);
        await waitForState(exit, state => state.state === 'BLOCKED', 'blocked cancel keeps BLOCKED');
        assert.equal(counts.drain, 1);
        const secondInstance = appListeners['second-instance'];
        assert.equal(typeof secondInstance, 'function', 'main.cjs 必须真实注册 second-instance 处理器');
        secondInstance(); // app relaunch while BLOCKED: the always-available native retry entry
        await waitForState(exit, state => state.quitReady === true, 'the relaunch retry entry must reach the coordinator', 4000);
        assert.deepEqual([counts.confirm, counts.drain], [1, 2], '应用重启重试入口必须真实到达协调器且恰重跑一次排空');
        assert.equal(counts.blocked, 1, '重试成功不得再次弹出提示');
        assert.deepEqual(locks, [true]);
    } finally {
        // bounded: exactly one notice is raised and answered synchronously ('cancel'); on the
        // pre-fix snapshot the handler no-ops (createWindow never ran) and the flow is already
        // settled in BLOCKED — nothing stays pending either way.
    }
});

test('RP2 F4: two consecutive finalize failures — BOTH 继续等待 answers are consumed exactly once (confirm 1 / notices 2 / drains 3 / finalizes 3, no recursion, no dropped decision)', async () => {
    let finalizeCalls = 0;
    const { exit, counts, locks } = coordinatorFixture({
        confirm: 'discarded',
        prepareExit: async () => ({ ok: true }),
        finalizeClose: () => { finalizeCalls += 1; if (finalizeCalls <= 2) throw Error(`注入：最终关窗失败 #${finalizeCalls}`); },
        blockedAnswer: 'retry', // bounded: exactly two notices, then the third finalize succeeds
    });
    try {
        assert.equal(exit.handleClose(), true);
        await waitForState(exit, state => state.quitReady === true, 'the SECOND retry answer must not be dropped', 4000);
        assert.deepEqual([counts.confirm, counts.blocked, counts.drain, finalizeCalls], [1, 2, 3, 3],
            `连续两次失败后两次“继续等待”都必须被准确消费：${JSON.stringify({ counts, finalizeCalls })}`);
        assert.deepEqual(locks, [true]);
    } finally {
        // bounded: the fixture answers every notice synchronously and finalize #3 succeeds, so
        // no self-built barrier can stay pending (on the pre-fix snapshot the flow settles in
        // BLOCKED by itself — nothing is left awaiting).
    }
});
