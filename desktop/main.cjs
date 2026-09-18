const { app, BrowserWindow, Menu, protocol, dialog } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { attachIntegration } = require('./integration.cjs');
const { attachUpdates } = require('./updates.cjs');
const { attachFiles } = require('./files.cjs');

const origin = 'director://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'director', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
// Tests use an independent, empty profile. Packaged applications ignore this switch.
if (!app.isPackaged && app.commandLine.hasSwitch('director-test-profile'))
    app.setPath('userData', path.resolve(app.commandLine.getSwitchValue('director-test-profile')));
app.setName('DirectorDesk');
let window;
let exitCoordinator = null;
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// --- RP2/R1-R3: unified exit coordination (main-process internal; no IPC/preload contract change) ---
// All quit entries — window close, app.quit() and the update restart — funnel through ONE state
// machine: OPEN → CONFIRMING (files three-choice confirm; cancel returns to OPEN with the
// storage service untouched and the window fully usable) → DRAINING (storage stop + drain + DB
// close, window interaction locked, real bounded budget) → READY (one-shot final release flag)
// → FINALIZING (the single final-action owner closes the window, or the installer performs
// quitAndInstall). From the moment the drain starts the storage service is STOPPED, so every
// failure path — a blocked drain cancelled by the user, a throwing drain, a throwing final
// action or a failed installer restart — lands in BLOCKED with the window KEPT LOCKED: the
// machine never returns to OPEN with a stopped service pretending the editor is usable, and
// BLOCKED exposes clear native controlled-retry entries (a new close/quit attempt, or
// relaunching the app). A failed final action clears its one-shot authorization before
// re-arming; exactly one final action runs per authorization.
// F3/F4 (ownership): ONE non-recursive scheduler (pump) owns the attempt/notice/retry chain —
// at most one native notice is pending at any time and it OWNS the decision: while it is up,
// every external entry (close, before-quit, second-instance relaunch) is only refused — never
// started or backlogged behind the user's back. The notice's 继续等待 answer is the at-most-one
// retry decision and is consumed exactly once by the loop, so consecutive failures can never
// drop a second answer; stale/late callbacks verify ownership before touching state.
function createExitCoordinator({ confirmExit, prepareExit, showBlockedDialog, setInteractionLocked, finalizeClose, drainTimeoutMs }) {
    let state = 'OPEN';          // OPEN | CONFIRMING | DRAINING | BLOCKED | READY | FINALIZING
    let quitReady = false;       // one-shot final release: authorized right before the final action
    let finalKind = null;        // 'close' | 'quit' | 'update' — the single final-action owner
    let flow = null;             // the ONE active sequence promise (null once settled)
    let noticeInFlight = false;  // F2/F3: at most ONE native blocked notice pending at any time
    const drainArgs = () => (drainTimeoutMs ? { timeoutMs: drainTimeoutMs } : undefined);
    /** ONE drain attempt under a fresh bounded budget; a thrown drain becomes the SAME blocked
     * result shape (F2) so the owned native notice — never an unhandled rejection — owns it. */
    async function attemptDrain() {
        try {
            return await prepareExit(drainArgs());
        } catch (error) {
            return { ok: false, blocked: 'internal', detail: `退出排空出现内部错误（存储服务已停止，工程不能再保存）：${error && error.message ? error.message : error}` };
        }
    }
    /** The ONE owned native notice (single flight). A crashed prompt is contained — treated as
     * cancel: stay BLOCKED + locked, never an unhandled rejection, never a release, no loop. */
    async function ownNotice(info) {
        noticeInFlight = true;
        try {
            return await showBlockedDialog(info && typeof info === 'object' ? info : { blocked: 'internal', detail: '退出过程中出现内部错误，存储服务已停止。' });
        } catch {
            return 'cancel'; // F2: a crashed prompt must not escalate or loop — stay BLOCKED
        } finally {
            noticeInFlight = false;
        }
    }
    /** A failure AFTER the storage service stopped: keep the lock and the protection, land in
     * BLOCKED, clear any erroneous authorization. Never back to OPEN. */
    function landBlockedAfterStop() {
        quitReady = false;
        state = 'BLOCKED';
    }
    /** The single final action, authorized exactly once per attempt. */
    function runFinalAction() {
        state = 'READY';
        quitReady = true; // one-shot authorization for THIS final attempt
        state = 'FINALIZING';
        if (finalKind === 'update') return true; // the installer owns quitAndInstall
        finalizeClose(); // window.close() → all-closed → app.quit()
        return true;
    }
    /** THE single non-recursive scheduler (F3/F4): one attempt → on failure the ONE owned
     * notice → the answer is the at-most-one user retry decision, consumed EXACTLY ONCE by
     * continuing the loop — never by a recursive/self-awaiting retry, so a second consecutive
     * failure cannot drop the second 继续等待 (F4). While a notice is pending the scheduler
     * simply waits for the user; the external entries are refused by their guards (F3) and
     * never start or backlog an attempt behind the pending decision. */
    async function pump() {
        for (;;) {
            state = 'DRAINING';
            setInteractionLocked(true);
            const result = await attemptDrain();
            if (result && result.ok === true) {
                try {
                    return runFinalAction();
                } catch (error) {
                    landBlockedAfterStop(); // clear the one-shot authorization; stay locked
                    const answer = await ownNotice({ blocked: 'internal', detail: `最终关窗失败（存储服务已停止，工程不能再保存）：${error && error.message ? error.message : error}` });
                    if (answer !== 'retry') return false; // BLOCKED, locked; native entries remain
                    continue; // consume the decision once → the next attempt, no recursion
                }
            }
            const answer = await ownNotice(result); // the SAME prompt covers blocked results AND thrown drains
            if (answer !== 'retry') { landBlockedAfterStop(); return false; }
            // Decision consumed once → the loop starts the next attempt (fresh budget).
        }
    }
    /** Runs one bounded sequence and clears the flow slot when it settles, so exactly one
     * sequence can exist at a time. Containment belt: the pump contains drain/notice/finalize
     * failures itself; anything unexpected still lands BLOCKED + locked with the SAME notice. */
    function startSequence(run) {
        const seq = (async () => {
            try {
                return await run();
            } catch (error) {
                landBlockedAfterStop();
                await ownNotice({ blocked: 'internal', detail: `退出重试失败（存储服务已停止，工程不能再保存）：${error && error.message ? error.message : error}` });
                return false;
            } finally {
                if (flow === seq) flow = null;
            }
        })();
        flow = seq;
        return seq;
    }
    /** First entry: the one user confirmation, then the pump. A cancel or a failure BEFORE
     * anything stopped returns to a fully usable OPEN window; from the first drain on, every
     * failure stays BLOCKED and locked (the storage service stopped synchronously). */
    async function runFlowWithConfirm() {
        let outcome;
        try {
            outcome = await confirmExit(); // 'saved' | 'discarded' | 'cancelled'
        } catch {
            state = 'OPEN'; // R1: a failure before anything stopped leaves the window fully usable
            finalKind = null;
            return false;
        }
        if (outcome !== 'saved' && outcome !== 'discarded') {
            state = 'OPEN';
            finalKind = null;
            return false;
        }
        return pump();
    }
    /** R1/F3: the controlled retry entry from BLOCKED (a new close/quit attempt, or app
     * relaunch via second-instance). ONE sequence owner: refused while a notice is pending —
     * the pending notice owns the decision and its answer is the only queued retry — and
     * refused while another sequence still runs. A failed update ownership degrades to a
     * NORMAL close exit; the installer is never silently re-run. */
    function retryBlockedExit() {
        if (state !== 'BLOCKED' || noticeInFlight || flow) return false;
        if (finalKind === 'update') finalKind = 'close';
        return startSequence(() => pump());
    }
    function requestExit(kind) {
        if (quitReady || state !== 'OPEN') return null; // reentries fold into the owner's flow
        state = 'CONFIRMING';                           // synchronous — before the first await
        if (!finalKind) finalKind = kind;
        return startSequence(() => runFlowWithConfirm());
    }
    const coordinator = {
        /** window 'close' — true when the attempt is intercepted this time. In BLOCKED the
         * interception is the controlled retry entry — unless a native notice is already
         * pending, in which case the notice owns the decision (F3: refuse, never backlog). */
        handleClose() {
            if (quitReady) return false;
            if (state === 'BLOCKED') {
                if (!noticeInFlight && !flow) void retryBlockedExit();
                return true;
            }
            if (state !== 'OPEN') return true;
            requestExit('close');
            return true;
        },
        /** app 'before-quit' — same interception/retry contract as handleClose. */
        handleQuit() {
            if (quitReady) return false;
            if (state === 'BLOCKED') {
                if (!noticeInFlight && !flow) void retryBlockedExit();
                return true;
            }
            if (state !== 'OPEN') return true;
            requestExit('quit');
            return true;
        },
        /** Update entry (awaited inside the existing confirmInstall): true only when this call
         * acquired the update ownership AND the shared drain reached READY. While BLOCKED the
         * installer gets no new ownership — the native retry entry exits normally instead, and
         * a later normal-close success is never reported as an install grant. */
        prepareUpdateExit() {
            if (state === 'BLOCKED') return Promise.resolve(false);
            const claimed = requestExit('update');
            if (!claimed) return Promise.resolve(false);
            return claimed;
        },
        /** R3/F2/F3: the installer reports a failed restart (sync throw or async error) after
         * it was granted the final action. The owner gate comes FIRST — a LATE stale callback
         * from an old attempt can neither revoke a new owner's authorization nor re-prompt.
         * The failure surfaces through the SAME owned notice; its answer is the one retry
         * decision, consumed exactly once by continuing into the pump (the retry degrades to a
         * normal close — no reinstall). */
        reportFinalActionFailure(kind) {
            if (state !== 'FINALIZING' || finalKind !== kind || !quitReady) return false;
            landBlockedAfterStop(); // clear the erroneous authorization; stay BLOCKED + locked
            if (finalKind === 'update') finalKind = 'close';
            void startSequence(async () => {
                const answer = await ownNotice({ blocked: 'install-failed', detail: '更新安装重启失败，未安装任何内容（存储服务已停止，工程不能再保存）。可重试退出，将正常关闭应用，不会自动重新安装。' });
                if (answer !== 'retry') return false;
                return pump();
            });
            return true;
        },
        /** R1/F3: app relaunch (second-instance) as an always-available native retry entry —
         * refused while a notice is pending or another sequence runs (never behind the user's
         * back, never backlogged). */
        retryBlockedExit,
        /** Navigation save-exit handoff (receipt routed through the shared confirmation). */
        confirmSaveExit() {
            const claimed = requestExit('close');
            if (claimed) void claimed;
        },
        /** True once the final release flag is set: will-prevent-unload must not prompt again. */
        unloadAllowed: () => quitReady,
        /** Inspection hook (not part of any public surface). */
        state: () => ({ state, quitReady, finalKind }),
    };
    // The app has exactly ONE coordinator (created by createWindow); binding it here lets the
    // REAL second-instance wiring below reach the instance both in production and in the unit
    // harness (createWindow never runs under node:test, so nothing else sets this binding).
    exitCoordinator = coordinator;
    return coordinator;
}

async function createWindow() {
    const windowTitle = app.isPackaged ? '导演台' : '导演台 · 开发测试版';
    window = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1000, minHeight: 720, show: false,
        title: windowTitle, backgroundColor: '#101214', icon: path.join(__dirname, 'icon.ico'),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
    window.on('page-title-updated', (event, title) => {
        event.preventDefault();
        const name = title || '导演台';
        window.setTitle(!app.isPackaged && !name.endsWith(' · 开发测试版') ? name + ' · 开发测试版' : name);
    });
    const integration = attachIntegration(window);
    const files = attachFiles(window);
    // RP2: unified exit coordination for the close/app.quit/update entries (see
    // createExitCoordinator above). Order matters: files first (confirmExit), then the
    // coordinator, then updates (its confirmInstall joins the coordinator).
    exitCoordinator = createExitCoordinator({
        confirmExit: () => files.confirmExit(),
        prepareExit: options => integration.prepareExit(options),
        showBlockedDialog: info => dialog.showMessageBox(window, {
            type: 'warning', title: '退出受阻', message: '还有存储操作未完成，暂时不能退出。',
            detail: (info && info.detail ? info.detail + '\n\n' : '') + '可以继续等待未完成的操作；取消退出后窗口保留但不可操作（存储服务已停止，工程不能再保存），可再次尝试退出或重新启动导演台来继续处理。',
            buttons: ['继续等待', '取消退出'], defaultId: 0, cancelId: 1, noLink: true,
        }).then(result => (result.response === 0 ? 'retry' : 'cancel')),
        setInteractionLocked: locked => { if (!window.isDestroyed()) window.setEnabled(!locked); },
        finalizeClose: () => { if (!window.isDestroyed()) window.close(); },
    });
    const updates = attachUpdates(window, integration, exitCoordinator);
    Menu.setApplicationMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== origin + '/') event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-prevent-unload', event => {
        if (exitCoordinator.unloadAllowed() || updates.isQuitting()) { event.preventDefault(); return; }
        if (files.preventUnload(event) === 'save-exit-requested') exitCoordinator.confirmSaveExit();
    });
    window.on('close', event => { if (exitCoordinator.handleClose()) event.preventDefault(); });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    try { await files.ready; } catch { dialog.showErrorBox('文件位置不可用', '请检查默认目录或本机文件位置配置。'); }
    void window.loadURL(origin + '/');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => {
        if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
        // R1: relaunching the app is an always-available native retry entry while an exit is
        // BLOCKED (the window itself stays locked because the storage service is stopped).
        if (exitCoordinator && exitCoordinator.state().state === 'BLOCKED') exitCoordinator.retryBlockedExit();
    });
    app.whenReady().then(() => {
        app.setAppUserModelId('app.directordesk.desktop');
        const webRoot = fsSync.existsSync(path.join(app.getAppPath(), 'dist'))
            ? path.join(app.getAppPath(), 'dist')
            : path.resolve(__dirname, '../dist');
        protocol.handle('director', async request => {
            try {
                const url = new URL(request.url), relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
                if (url.hostname !== 'app' || request.method !== 'GET' || !/^(?:index\.html|favicon\.svg|assets\/[A-Za-z0-9_-]+\.(?:js|css)|assets\/three\.core-[A-Za-z0-9_-]+\.js)$/.test(relative))
                    return new Response('Not found', { status: 404 });
                const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(relative)];
                return new Response(await fs.readFile(path.join(webRoot, relative)), { headers: {
                    'Content-Type': mime + '; charset=utf-8', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
            } catch { return new Response('Not found', { status: 404 }); }
        });
        createWindow();
    });
    app.on('window-all-closed', () => app.quit());
    // RP2: before-quit is the synchronous interception point for app.quit(); the window close
    // entry is intercepted by the per-window 'close' handler in createWindow.
    app.on('before-quit', event => { if (exitCoordinator && exitCoordinator.handleQuit()) event.preventDefault(); });
}

module.exports = { createExitCoordinator };
