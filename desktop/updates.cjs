const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { withRevisionVersions } = require('./revision-updater.cjs');
const RevisionUpdater = withRevisionVersions(NsisUpdater);
const { createUpdateConfig } = require('./update-config.cjs');
const { createUpdateHost } = require('./update-host.cjs');
const { githubRelease } = require('./github-release.cjs');
function attachUpdates(window, integration, exit) {
    let quitting = false;
    // The updater chain (NsisUpdater + quitAndInstall) is Windows-specific; packaged mac builds only offer the release page.
    const mode = !app.isPackaged ? 'development' : process.platform === 'darwin' ? 'unsupported'
        : fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'portable.json')) ? 'portable' : 'installed';
    const host = createUpdateHost({ version: app.getVersion(), mode, config: createUpdateConfig(app.getPath('userData')),
        makeUpdater: feed => new RevisionUpdater(feed), getGithubRelease: githubRelease,
        send: state => { if (!window.isDestroyed()) window.webContents.send('director-update-state', state); },
        confirmInstall: async () => {
            if (integration.isBusy()) throw Error('请等待 AI 或工具任务完成后再更新');
            const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '重启安装更新', message: '现在关闭导演台并安装新版本？',
                detail: '当前工程的自动恢复副本已保存。对话和渠道配置保留在本机。', buttons: ['稍后', '重启安装'], defaultId: 0, cancelId: 0, noLink: true });
            if (choice !== 1) return false;
            // RP2: the update entry joins the unified exit coordinator (same confirmation →
            // storage drain → DB close as close/app.quit). quitAndInstall may only run once this
            // call acquired the update ownership AND the shared drain reached READY; a blocked
            // drain or a competing exit flow reports false and nothing is installed.
            if (!exit || typeof exit.prepareUpdateExit !== 'function') return true;
            return await exit.prepareUpdateExit();
        },
        install: updater => {
            quitting = true;
            // RP2/R3: a failed installer restart (sync throw or async error) must not leave the
            // exit coordinator stuck in FINALIZING with a stale authorization. Report the
            // failure so the coordinator clears the grant, keeps the stopped-service protection
            // and offers its native retry (which exits normally — the installer is never
            // silently re-run). update-host stays untouched; it still surfaces phase error.
            const reportFailure = () => {
                quitting = false;
                if (exit && typeof exit.reportFinalActionFailure === 'function') exit.reportFinalActionFailure('update');
            };
            updater.once('error', reportFailure);
            try {
                updater.quitAndInstall(false, true);
            } catch (error) {
                updater.removeListener('error', reportFailure);
                reportFailure();
                throw error; // update-host keeps surfacing the failure honestly (phase error)
            }
        },
        openPage: url => shell.openExternal(url),
    });
    ipcMain.handle('director-updates', async (event, input) => {
        if (event.sender !== window.webContents || event.senderFrame?.url !== 'director://app/') throw Error('拒绝未知页面');
        try {
            const action = input?.action; let data;
            if (action === 'state') { await host.initialize(); data = host.read(); }
            else if (action === 'save') data = await host.save(input.data);
            else if (action === 'check') data = await host.check();
            else if (action === 'download') data = await host.download();
            else if (action === 'install') data = await host.install();
            else if (action === 'page') { await host.openPage(); data = host.read(); }
            else throw Error('未知更新操作');
            return { ok: true, data };
        } catch (error) { return { ok: false, error: error.message }; }
    });
    const timer = setTimeout(async () => { try { await host.initialize(); if (mode !== 'development') await host.check(); } catch { /* Startup checks stay silent when offline. */ } }, 3000);
    timer.unref();
    window.on('closed', () => { clearTimeout(timer); host.dispose(); ipcMain.removeHandler('director-updates'); });
    return { isQuitting: () => quitting };
}
module.exports = { attachUpdates };
