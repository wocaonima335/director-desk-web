// DSK-004-RP2 exit verification (A6) on the REAL prepared Electron app in .audit/desktop-app.
// Three real processes exercise the unified exit coordinator end to end:
//   Phase A — window close: cancel keeps the window open with a usable storage service; the
//             confirmed save path drains (storage dispose incl. DB close) strictly before the
//             window closes and the app quits; the saved file really exists afterwards.
//   Phase B — app.quit(): before-quit is intercepted once, one shared confirmation flow runs,
//             and the app exits cleanly (the trailing window close passes the final release).
//   Phase C — blocked drain: a stuck native directory picker holds a real in-flight storage
//             handler (pendingOperations), so dispose times out and the native blocked prompt
//             appears; cancelling keeps the window open and LOCKED with the service honestly
//             stopped (new dsk requests are refused, the DB is not faked back open); a new
//             close attempt is the controlled retry (no second confirmation, prompt re-appears
//             while still stuck); releasing the picker lets the retry drain for real and the
//             app exits cleanly — window locked throughout.
//   Phase D — NATURAL exit smoke: no before-quit instrumentation at all; the app must
//             terminate on its own with real exit code 0 (no forced kill anywhere).
// EVIDENCE LABELS: the confirm/save/picker/blocked dialogs are MAIN-PROCESS STUBS injected over
// CDP (native dialogs are not CDP-drivable) — the wiring they drive (files.cjs confirmExit,
// storage dispose drain, main.cjs coordinator) is the real product. Native click-through of
// those dialogs stays on the manual verification boundary. The simulated-updater
// drain-before-install proof (A5) lives in tests/dsk-rp2-exit.test.cjs (real updates.cjs wiring
// + a clearly labeled fake updater), not here — nothing is ever installed by this script.
// MECHANICS: to assert the exact dialog counts after the whole exit chain ran, the stub holds
// the FIRST passing before-quit (all windows already closed — the flow reached its final step)
// for one preventDefault, the runner then reads the recorded state from the still-alive main
// process and releases the app with a second quit.
// Usage: node scripts/test-dsk-rp2-exit-desktop.mjs   (run after npm run desktop:prepare)
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import { _electron as electron } from 'playwright-core';

const root = path.resolve('.');
const staged = path.resolve(process.env.DIRECTOR_TEST_APP || '.audit/desktop-app');
const fail = message => {
    console.error('DESKTOP-RP2-EXIT-FAIL: ' + message);
    process.exitCode = 1;
};

// Preflight: the staged payload must actually contain the RP2 exit coordination, otherwise the
// run below would silently verify a stale build.
for (const file of ['package.json', 'desktop/main.cjs', 'desktop/files.cjs', 'desktop/integration.cjs', 'desktop/updates.cjs']) {
    if (!fsSync.existsSync(path.join(staged, file))) fail(`missing prepared file ${file} (run npm run desktop:prepare first)`);
}
const markerChecks = [
    ['desktop/main.cjs', ['createExitCoordinator', '退出受阻', 'prepareUpdateExit']],
    ['desktop/files.cjs', ['confirmExit']],
    ['desktop/integration.cjs', ['prepareExit', 'storage-unavailable']],
    ['desktop/updates.cjs', ['prepareUpdateExit', 'quitAndInstall']],
];
for (const [file, markers] of markerChecks) {
    const text = fsSync.readFileSync(path.join(staged, file), 'utf8');
    for (const marker of markers) {
        if (!text.includes(marker)) fail(`staged ${file} lacks RP2 marker: ${marker}`);
    }
}
if (process.exitCode) process.exit(process.exitCode);

// Hard deadline so a stalled app cannot hang the runner (exit 0 only on success).
const deadline = setTimeout(() => {
    fail('global deadline (240s) exceeded');
    process.exit(1);
}, 240000).unref();

const require = createRequire(import.meta.url);
const executable = require('electron');

// Phase C needs a project with a REAL committed snapshot (backup.create refuses snapshotless
// projects before reaching its dialog), so fabricate a genuine SceneDocument the same way the
// storage desktop script does — via the production engine factory, bundled with esbuild.
const helperFile = path.join(root, 'tmp', `rp2-exit-helper-${process.pid}.cjs`);
await esbuild.build({
    stdin: { contents: "export { readSceneDocument } from './src/scenes/sequence-project.ts';\nexport { demoProject } from './src/model.ts';", resolveDir: root, loader: 'ts' },
    outfile: helperFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
process.on('exit', () => { try { fsSync.rmSync(helperFile, { force: true }); } catch { /* best effort */ } });
const helper = require(helperFile);
const rp2DocumentJson = JSON.stringify((() => {
    const document = helper.readSceneDocument(helper.demoProject());
    document.name = 'RP2退出受阻';
    return document;
})());
const launchApp = async name => {
    const dir = path.join(root, 'tmp', `rp2-exit-desktop-${process.pid}-${name}`);
    const profile = path.join(dir, 'profile');
    const storageDir = path.join(dir, 'storage');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(storageDir, { recursive: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // Short REAL exit-drain budget: honored only by unpackaged test builds (integration.cjs).
    if (name === 'c') env.DIRECTOR_STORAGE_DISPOSE_TIMEOUT_MS = '700';
    const app = await electron.launch({
        executablePath: executable,
        args: [staged, `--director-test-profile=${profile}`, `--director-storage-dir=${storageDir}`],
        env,
    });
    return { app, dir, savePath: path.join(dir, 'saved.director') };
};

/** Inject the dialog stubs into the real main process. Every stub records its options; the
 * before-quit hook — when armed — holds the FIRST before-quit that arrives with all windows
 * already closed (i.e. the unified flow's final step) so the runner can read the recorded
 * state from the still-alive process before releasing the quit. Phase D disables the hold to
 * prove the app terminates NATURALLY with no instrumentation at the exit point. */
const installDialogStubs = (app, { savePath, choice, holdPicker = false, holdAtFinalQuit = true }) => app.evaluate(({ dialog, app: electronApp, BrowserWindow }, config) => {
    globalThis.rp2Exit = {
        choice: config.choice, syncDialogs: [], blockedDialogs: [], saveDialogs: [],
        openDialogs: 0, released: false, heldAtFinalQuit: false,
    };
    let releasePicker = () => { };
    let holdingArmed = config.holdAtFinalQuit === true;
    dialog.showMessageBoxSync = (_window, options) => {
        globalThis.rp2Exit.syncDialogs.push(options);
        return globalThis.rp2Exit.choice;
    };
    dialog.showMessageBox = async (_window, options) => {
        globalThis.rp2Exit.blockedDialogs.push(options);
        return { response: 1 }; // 取消退出 — the blocked prompt's cancel button
    };
    dialog.showSaveDialog = async (_window, options) => {
        globalThis.rp2Exit.saveDialogs.push(options);
        return { canceled: false, filePath: config.savePath };
    };
    dialog.showOpenDialog = async () => new Promise(resolve => {
        globalThis.rp2Exit.openDialogs += 1;
        if (!config.holdPicker) { resolve({ canceled: true, filePaths: [] }); return; }
        releasePicker = () => { globalThis.rp2Exit.released = true; resolve({ canceled: true, filePaths: [] }); };
        globalThis.rp2Exit.releasePicker = () => releasePicker();
    });
    // Registered AFTER the coordinator's own before-quit listener, so it only sees the quit
    // call the coordinator already let through. Holding needs all windows closed, which means
    // the whole flow (confirm → drain → final close) already completed.
    electronApp.on('before-quit', event => {
        if (!holdingArmed || BrowserWindow.getAllWindows().length > 0) return;
        holdingArmed = false;
        event.preventDefault();
        globalThis.rp2Exit.heldAtFinalQuit = true;
    });
}, { savePath, choice, holdPicker, holdAtFinalQuit });

const waitForHeldFinalQuit = async (handle, label, timeoutMs = 30000) => {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        try {
            const held = await handle.app.evaluate(() => globalThis.rp2Exit.heldAtFinalQuit);
            if (held === true) return;
        } catch (error) {
            throw new Error(`${label}：等待最终退出钩子时应用提前退出 — ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${label}：最终退出钩子未被触发（排空未完成或流程卡住）`);
};

try {
    // --- Phase A: window close — cancel stays open; confirmed save drains before exit ---------
    const a = await launchApp('a');
    await installDialogStubs(a.app, { savePath: a.savePath, choice: 2 });
    const pageA = await a.app.firstWindow();
    a.page = pageA;
    pageA.on('dialog', () => { });
    await pageA.waitForSelector('.application-menu');
    // Make the document dirty so the save path really writes through the renderer save chain.
    await pageA.locator('#duration').fill('40');
    await pageA.locator('#duration').press('Tab');

    await a.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await pageA.waitForTimeout(500);
    const cancelState = await a.app.evaluate(({ BrowserWindow }) => ({
        state: globalThis.rp2Exit,
        windowGone: BrowserWindow.getAllWindows().length === 0,
        visible: BrowserWindow.getAllWindows()[0] && !BrowserWindow.getAllWindows()[0].isDestroyed() && BrowserWindow.getAllWindows()[0].isVisible(),
        enabled: BrowserWindow.getAllWindows()[0] && BrowserWindow.getAllWindows()[0].isEnabled(),
    }));
    assert.equal(cancelState.windowGone, false, '取消退出后窗口必须仍然存在');
    assert.equal(cancelState.visible, true, '取消退出后窗口必须可见');
    assert.equal(cancelState.enabled, true, '取消退出后窗口必须保持可交互');
    assert.equal(cancelState.state.syncDialogs.length, 1, '取消路径只出现一次三选确认');
    assert.deepEqual(cancelState.state.syncDialogs[0].buttons, ['保存并退出', '不保存退出', '取消']);
    assert.equal(cancelState.state.syncDialogs[0].cancelId, 2, '三选确认的取消键必须是取消');
    assert.equal(cancelState.state.blockedDialogs.length, 0, '取消路径不得出现受阻提示');
    assert.equal(await pageA.locator('#duration').inputValue(), '40', '取消后文档保持可编辑状态');
    // A3 on the real wiring: after a cancelled exit the storage service is still fully usable.
    const bootAfterCancel = await pageA.evaluate(() => window.directorDesktop.dsk('storage.v1.session.bootstrap', {}));
    assert.equal(bootAfterCancel.ok, true, `取消退出后存储服务必须仍然可用：${JSON.stringify(bootAfterCancel)}`);
    console.log('PHASE-A1-OK: cancel close keeps the window open, interactive, with a usable storage service and zero blocked prompts');

    // Confirmed save: the save receipt hands the exit to the coordinator; storage drains (DB
    // close included) strictly before the window closes and the app quits.
    await a.app.evaluate(() => { globalThis.rp2Exit.choice = 0; });
    await a.app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    await waitForHeldFinalQuit(a, '保存退出');
    const stateA = await a.app.evaluate(({ BrowserWindow }) => ({
        state: globalThis.rp2Exit, windows: BrowserWindow.getAllWindows().length,
    }));
    assert.equal(stateA.windows, 0, '保存退出流程末尾窗口必须已经关闭');
    assert.equal(stateA.state.syncDialogs.length, 2, `整个保存退出只允许两次确认（取消一次+保存一次）：${JSON.stringify(stateA.state.syncDialogs.length)}`);
    assert.equal(stateA.state.saveDialogs.length, 1, '保存路径必须恰好出现一次保存对话框');
    assert.equal(stateA.state.blockedDialogs.length, 0, '干净退出不得出现受阻提示');
    assert.equal(stateA.state.released, false, '干净退出不得动用挂起选择器');
    const saved = JSON.parse(await fs.readFile(a.savePath, 'utf8'));
    assert.equal(saved.scenes.find(scene => scene.id === saved.activeSceneId).state.duration, 40, '保存退出必须把已编辑文档真实写盘');
    const exitedA = a.app.waitForEvent('close', { timeout: 15000 });
    await a.app.evaluate(({ app }) => app.quit());
    await exitedA;
    console.log('PHASE-A2-OK: confirmed save runs confirm → drain → close → quit; the document is on disk and no blocked prompt appears');

    // --- Phase B: app.quit() — one intercepted before-quit, one shared flow, clean exit -------
    const b = await launchApp('b');
    await installDialogStubs(b.app, { savePath: b.savePath, choice: 1 });
    const pageB = await b.app.firstWindow();
    b.page = pageB;
    pageB.on('dialog', () => { });
    await pageB.waitForSelector('.application-menu');
    await b.app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    await waitForHeldFinalQuit(b, 'app.quit');
    const stateB = await b.app.evaluate(() => globalThis.rp2Exit);
    assert.equal(stateB.syncDialogs.length, 1, `app.quit 全程只允许一次确认（最终关窗走放行标志）：${JSON.stringify(stateB.syncDialogs.length)}`);
    assert.equal(stateB.blockedDialogs.length, 0, '干净 app.quit 不得出现受阻提示');
    const exitedB = b.app.waitForEvent('close', { timeout: 15000 });
    await b.app.evaluate(({ app }) => app.quit());
    await exitedB;
    console.log('PHASE-B-OK: app.quit is intercepted once, one shared confirm/drain flow runs and the app exits cleanly');

    // --- Phase C: blocked drain — native prompt, cancel keeps the window LOCKED (the service
    // --- is stopped: no fake recovery to an editable OPEN state), the close entry is the ----
    // --- controlled retry, and the real retry exits cleanly once the stuck handler ends ------
    const c = await launchApp('c');
    await installDialogStubs(c.app, { savePath: c.savePath, choice: 1, holdPicker: true });
    const pageC = await c.app.firstWindow();
    c.page = pageC;
    pageC.on('dialog', () => { });
    await pageC.waitForSelector('.application-menu');
    // Hold a REAL storage handler in-flight: create a project, commit one real snapshot, then
    // start backup.create, which waits on the (hung) directory picker — pendingOperations stays
    // 1 and the exit drain can never finish while it is stuck.
    const projectId = await pageC.evaluate(async documentJson => {
        const call = (action, data) => window.directorDesktop.dsk(action, data);
        const created = await call('project.create', { name: 'RP2退出受阻' });
        if (!created.ok) throw new Error('project.create failed: ' + JSON.stringify(created));
        const bytes = new TextEncoder().encode(documentJson);
        const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: bytes.length });
        if (!begin.ok) throw new Error('upload.begin failed: ' + JSON.stringify(begin));
        const { transferId, chunkSize } = begin.data;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
            let binary = '';
            for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
            const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: btoa(binary) });
            if (!chunk.ok) throw new Error('upload.chunk failed: ' + JSON.stringify(chunk));
        }
        const commit = await call('storage.v1.upload.commit', { transferId });
        if (!commit.ok) throw new Error('upload.commit failed: ' + JSON.stringify(commit));
        window.__stuckBackup = call('storage.v1.backup.create', { projectId: created.data.projectId });
        return created.data.projectId;
    }, rp2DocumentJson);
    await pageC.waitForTimeout(200);
    await c.app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    let blockedSeen = null;
    for (let waited = 0; waited < 10000; waited += 100) {
        try {
            const mid = await c.app.evaluate(({ BrowserWindow }) => ({ state: globalThis.rp2Exit, windows: BrowserWindow.getAllWindows().length }));
            if (mid.state.blockedDialogs.length === 1) { blockedSeen = mid; break; }
            if (mid.windows === 0 || mid.state.heldAtFinalQuit) throw new Error('窗口在受阻提示出现前就被关闭');
        } catch (error) { throw new Error('等待受阻提示时应用提前退出：' + error.message); }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(blockedSeen, '排空超时必须出现原生受阻提示');
    assert.equal(blockedSeen.state.syncDialogs.length, 1, '受阻路径只出现一次确认');
    assert.equal(blockedSeen.state.blockedDialogs[0].title, '退出受阻', '受阻提示必须是退出受阻对话框');
    assert.deepEqual(blockedSeen.state.blockedDialogs[0].buttons, ['继续等待', '取消退出']);
    assert.ok(String(blockedSeen.state.blockedDialogs[0].detail).includes('未完成的存储操作'), '受阻提示必须如实说明仍有未完成存储操作');
    // R1: the prompt was answered 取消退出 — the flow lands in BLOCKED and the window STAYS
    // LOCKED (the storage service is stopped; an editable unlocked window would be a lie).
    await new Promise(resolve => setTimeout(resolve, 400));
    const afterBlocked = await c.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return { gone: !w, destroyed: w && w.isDestroyed(), visible: w && w.isVisible(), enabled: w && w.isEnabled() };
    });
    assert.equal(afterBlocked.gone, false, '受阻取消后窗口必须保留');
    assert.equal(afterBlocked.destroyed, false);
    assert.equal(afterBlocked.visible, true);
    assert.equal(afterBlocked.enabled, false, '停服后受阻取消必须保持窗口锁定，不得解锁回可编辑假象');
    // Honest stop: the service was really stopped — new dsk requests are refused, nothing
    // pretends the editor can still save.
    const refused = await pageC.evaluate(() => window.directorDesktop.dsk('storage.v1.session.bootstrap', {}));
    assert.equal(refused.ok, false, '受阻取消后存储服务必须如实停止');
    const refusalText = JSON.stringify(refused.error);
    assert.ok(refusalText.includes('storage-unavailable') && refusalText.includes('存储服务已停止'),
        `拒绝必须说明服务已停止：${JSON.stringify(refused)}`);
    console.log(`PHASE-C1-OK: stuck in-flight handler times out the drain (project ${projectId.slice(0, 8)}), the native blocked prompt appears and cancelling keeps the window open and LOCKED with the service honestly stopped`);

    // R1 controlled retry entry: a new close attempt in BLOCKED re-runs the SAME drain with a
    // fresh budget and NO second confirmation — the picker is still parked, so the native
    // blocked prompt re-appears and the window remains locked.
    await c.app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    for (let waited = 0; waited < 10000; waited += 100) {
        try {
            const mid = await c.app.evaluate(() => globalThis.rp2Exit);
            if (mid.blockedDialogs.length === 2) break;
            if (mid.heldAtFinalQuit) throw new Error('重试未受阻就走到了最终退出');
        } catch (error) { throw new Error('等待第二次受阻提示时应用提前退出：' + error.message); }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const retried = await c.app.evaluate(({ BrowserWindow }) => ({
        state: globalThis.rp2Exit,
        enabled: BrowserWindow.getAllWindows()[0] && BrowserWindow.getAllWindows()[0].isEnabled(),
    }));
    assert.equal(retried.state.syncDialogs.length, 1, '受控重试不得对已确认过的用户重新弹确认');
    assert.equal(retried.enabled, false, '重试期间窗口必须保持锁定');
    console.log('PHASE-C2-OK: the close entry in BLOCKED is a real controlled retry — same drain, fresh budget, no second confirmation, window stays locked');

    // Fault removed: release the picker (the stuck handler completes), close once more — the
    // retry drains successfully (no new prompt) and the app exits cleanly through the hold.
    await c.app.evaluate(() => { globalThis.rp2Exit.releasePicker(); });
    await new Promise(resolve => setTimeout(resolve, 300));
    await c.app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    await waitForHeldFinalQuit(c, '受阻后重试退出');
    const stateC = await c.app.evaluate(({ BrowserWindow }) => ({ state: globalThis.rp2Exit, windows: BrowserWindow.getAllWindows().length }));
    assert.equal(stateC.windows, 0, '重试成功后窗口必须已关闭');
    assert.equal(stateC.state.syncDialogs.length, 1, `整个受阻→重试→退出只允许一次用户确认：${JSON.stringify(stateC.state.syncDialogs.length)}`);
    assert.equal(stateC.state.blockedDialogs.length, 2, '受阻提示必须恰好出现两次（首轮+重试轮）');
    assert.equal(stateC.state.openDialogs, 1, '挂起的选择器必须恰好被等待一次');
    assert.equal(stateC.state.released, true, '重试成功前必须已释放挂起的选择器');
    const exitedC = c.app.waitForEvent('close', { timeout: 15000 });
    await c.app.evaluate(({ app }) => app.quit());
    await exitedC;
    console.log('PHASE-C3-OK: after releasing the stuck handler the retry drains for real and the app exits cleanly — one confirmation, two honest blocked prompts, window locked throughout');

    // --- Phase D: NATURAL exit smoke — no instrumentation at the exit point; the app must ----
    // --- terminate on its own with exit code 0 through the real coordinator chain ------------
    const d = await launchApp('d');
    // Observe the REAL process termination from the moment of launch: after the app exits the
    // playwright connection is torn down, so the exit code must be captured via an exit hook —
    // a natural quit arrives with code 0 and NO signal (a killed process would carry one).
    const childD = d.app.process();
    const naturalExit = new Promise(resolve => childD.once('exit', (code, signal) => resolve({ code, signal })));
    await installDialogStubs(d.app, { savePath: d.savePath, choice: 1, holdAtFinalQuit: false });
    const pageD = await d.app.firstWindow();
    pageD.on('dialog', () => { });
    await pageD.waitForSelector('.application-menu');
    const exitedD = d.app.waitForEvent('close', { timeout: 30000 });
    await d.app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    await exitedD;
    const { code, signal } = await Promise.race([
        naturalExit,
        new Promise(resolve => setTimeout(() => resolve({ code: 'timeout', signal: 'timeout' }), 10000)),
    ]);
    assert.equal(code, 0, `自然退出必须以 0 结束（实际 ${code}），全程无强杀、无终点拦截`);
    assert.equal(signal, null, `必须是非信号自然终止（实际 ${signal}），脚本不以强杀充当成功`);
    console.log('PHASE-D-OK: un-instrumented natural exit — close → confirm → drain → quit, real process exit code 0, null signal, no forced kill');
    console.log(JSON.stringify({
        ok: true,
        evidence: 'real Electron app + real storage drain; dialog stubs are labeled mocks (native dialogs are not CDP-drivable); update/install proof is unit-level in tests/dsk-rp2-exit.test.cjs',
        checks: [
            'cancel close keeps window open with usable storage service',
            'confirmed save drains storage before close and really writes the file',
            'app.quit intercepts once with a single shared flow',
            'blocked drain shows the native blocked prompt and cancel keeps the window LOCKED',
            'blocked cancel honestly stops the service (new dsk requests refused)',
            'close entry in BLOCKED is a controlled retry without a second confirmation',
            'controlled retry after unblocking drains for real and exits cleanly',
            'un-instrumented natural exit with real process exit code 0',
        ],
    }));
} catch (error) {
    fail(error && error.stack ? error.stack : String(error));
}
process.exit(process.exitCode || 0);
