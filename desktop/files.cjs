const { app, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFileHost, defaultFileLocations } = require('./file-host.cjs');
const { installFilePermissions } = require('./file-permissions.cjs');

function attachFiles(window) {
    const session = window.webContents.session;
    installFilePermissions(session, window.webContents);
    const trusted = event => event.sender === window.webContents && event.senderFrame?.url === 'director://app/';
    const host = createFileHost({ directory: app.getPath('userData'), defaults: defaultFileLocations({
        isPackaged: app.isPackaged, documents: app.getPath('documents'), userData: app.getPath('userData'),
    }), chooseDirectory: async (kind, defaultPath) => {
        const result = await dialog.showOpenDialog(window, { title: kind === 'projects' ? '默认工程目录' : '默认导出目录', defaultPath, properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    }, chooseSave: async defaultPath => {
        const result = await dialog.showSaveDialog(window, { title: '保存项目', defaultPath, filters: [{ name: '导演台工程', extensions: ['director'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
        return result.canceled ? null : result.filePath;
    } });
    // RP2: one shared, awaitable exit confirmation replaces the old closeRequest/allowClose pair.
    // Every quit entry (window close, app.quit, update install via the unified coordinator in
    // main.cjs) awaits the same promise. A receipt resolves only ITS OWN request id, so a late
    // or stale receipt can never complete or trigger a newer exit, and the receipt NEVER closes
    // the window itself — the final close belongs to the unified exit coordinator.
    let exitConfirm = null; // { id, promise, resolve }
    const confirmDialogOptions = { type: 'question', title: '退出导演台',
        message: '是否保存当前工程后退出？', detail: '保存取消或失败时会留在编辑器。正在编辑或导出的任务需先完成或取消。',
        buttons: ['保存并退出', '不保存退出', '取消'], defaultId: 0, cancelId: 2, noLink: true };
    const closeResult = (event, result) => {
        if (!trusted(event) || !exitConfirm || result?.id !== exitConfirm.id) return;
        const resolve = exitConfirm.resolve;
        exitConfirm = null;
        resolve(result.saved === true ? 'saved' : 'cancelled');
    };
    /** Register the shared save request (no dialog). Used by confirmExit after the dialog and by
     * the navigation-protection save path. */
    function sendSaveRequest() {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        exitConfirm = { id: randomUUID(), promise, resolve };
        window.webContents.send('director-save-before-close', { id: exitConfirm.id });
        return promise;
    }
    // RP2: main-process-internal awaitable confirmation. The native three-choice dialog is shown
    // even when idle: the main process cannot know dirty state without a renderer handshake,
    // which stays out of scope this round. Repeat calls while a request is in flight join the
    // same promise. Cancel, save-cancel and save-failure resolve 'cancelled' — the window and the
    // storage service stay fully usable.
    function confirmExit() {
        if (exitConfirm) return exitConfirm.promise;
        const choice = dialog.showMessageBoxSync(window, confirmDialogOptions);
        if (choice === 1) return Promise.resolve('discarded');
        if (choice !== 0 || window.isDestroyed()) return Promise.resolve('cancelled');
        return sendSaveRequest();
    }
    ipcMain.handle('director-files', async (event, input) => {
        if (!trusted(event)) return { ok: false, error: '拒绝未知页面' };
        try {
            await host.ready;
            if (input?.action === 'locations') return { ok: true, data: host.read() };
            if (input?.action === 'choose') return { ok: true, data: await host.choose(input.data) };
            if (input?.action === 'save-project') return { ok: true, data: await host.saveProject(input.data) };
            if (input?.action === 'save-export') return { ok: true, data: await host.saveExport(input.data) };
            throw Error('未知文件操作');
        } catch (e) { return { ok: false, error: e.code ? '文件操作失败，请检查目录权限、磁盘空间或文件占用。工程仍保留在编辑器中。' : e.message }; }
    });
    ipcMain.on('director-save-close-result', closeResult);
    const download = (_event, item, contents) => {
        if (contents && contents !== window.webContents) return;
        item.setSaveDialogOptions({ title: '保存导演台文件', defaultPath: host.defaultPath(item.getFilename()) });
    };
    session.on('will-download', download);
    window.webContents.on('did-start-loading', () => {
        // A reload supersedes an in-flight exit confirmation; the window and the storage service
        // stay untouched and the awaiter observes an honest 'cancelled'.
        if (exitConfirm) { const resolve = exitConfirm.resolve; exitConfirm = null; resolve('cancelled'); }
    });
    window.on('closed', () => {
        ipcMain.removeHandler('director-files'); ipcMain.removeListener('director-save-close-result', closeResult);
        session.removeListener('will-download', download);
    });
    return { ready: host.ready, confirmExit,
        // Navigation/reload protection (renderer beforeunload) keeps its synchronous dialog.
        // Saving from here registers the SAME shared confirmation (no second dialog) and hands
        // the exit to the unified coordinator via 'save-exit-requested'.
        preventUnload(event) {
            if (exitConfirm) return null; // a confirmation is already in flight; keep unload prevented
            const choice = dialog.showMessageBoxSync(window, confirmDialogOptions);
            if (choice === 1) { event.preventDefault(); return null; } // leave without saving
            if (choice === 2) return null; // stay in the editor
            void sendSaveRequest();
            return 'save-exit-requested';
        } };
}
module.exports = { attachFiles };
