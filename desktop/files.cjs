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
    let closeRequest = '', allowClose = false;
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
    const closeResult = (event, result) => {
        if (!trusted(event) || !closeRequest || result?.id !== closeRequest) return;
        closeRequest = '';
        if (result.saved === true) { allowClose = true; window.close(); }
    };
    ipcMain.on('director-save-close-result', closeResult);
    const download = (_event, item, contents) => {
        if (contents && contents !== window.webContents) return;
        item.setSaveDialogOptions({ title: '保存导演台文件', defaultPath: host.defaultPath(item.getFilename()) });
    };
    session.on('will-download', download);
    window.webContents.on('did-start-loading', () => { closeRequest = ''; allowClose = false; });
    window.on('closed', () => {
        ipcMain.removeHandler('director-files'); ipcMain.removeListener('director-save-close-result', closeResult);
        session.removeListener('will-download', download);
    });
    return { ready: host.ready, preventUnload(event) {
        if (allowClose) { event.preventDefault(); return; }
        if (closeRequest) return;
        const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '退出导演台',
            message: '是否保存当前工程后退出？', detail: '保存取消或失败时会留在编辑器。正在编辑或导出的任务需先完成或取消。',
            buttons: ['保存并退出', '不保存退出', '取消'], defaultId: 0, cancelId: 2, noLink: true });
        if (choice === 1) { allowClose = true; event.preventDefault(); }
        if (choice === 0) { closeRequest = randomUUID(); window.webContents.send('director-save-before-close', { id: closeRequest }); }
    } };
}
module.exports = { attachFiles };
