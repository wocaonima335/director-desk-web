const { parseReleaseVersion, releaseVersion, compareReleaseVersions } = require('./release-version.cjs');
const { configureUpdater, probeUpdater, releaseNotes } = require('./update-provider.cjs');
/** Owns update state; Electron transport and local credentials are separate adapters. */
function createUpdateHost({ version, mode, config, makeUpdater, getGithubRelease, send, confirmInstall, install, openPage }) {
    version = releaseVersion(version);
    let updater, selected, flight = null, installing = false, disposed = false;
    let state = { currentVersion: version, mode, phase: 'idle', version: '', notes: '', percent: 0, message: '尚未检查更新', checkedAt: '', source: '', canDownload: false };
    const read = () => ({ ...state, config: config.read() });
    const publish = patch => { state = { ...state, ...patch }; if (!disposed) send(read()); };
    const fail = error => { // Provider errors may contain Authorization headers, local paths, or signed asset URLs.
        installing = false;
        const detail = String(error?.code || '') + ' ' + String(error?.message || '');
        const message = /401|403|404/.test(detail) ? '更新来源暂不可用，请确认服务器已发布更新文件。'
            : /sha512|checksum|signature/i.test(detail) ? '更新包校验失败，未安装。请重新下载或联系发布者。'
            : '更新请求失败，请检查网络及更新来源后重试。';
        publish({ phase: 'error', message, percent: 0 });
    };
    async function exclusive(fn) {
        if (flight || installing) throw Error('更新操作正在进行，请稍候');
        const task = Promise.resolve().then(fn); flight = task;
        try { await task; return read(); } finally { flight = null; }
    }
    function bindDownload(candidate) {
        updater = candidate;
        updater.on('download-progress', progress => publish({ phase: 'downloading', percent: Math.max(0, Math.min(100, progress.percent)), message: '正在下载更新…' }));
        updater.on('update-downloaded', () => publish({ phase: 'downloaded', percent: 100, message: '更新已下载并通过校验，可重启安装' }));
        updater.on('error', fail);
    }
    return { read, async initialize() { try { await config.ready; publish({}); } catch { publish({ phase: 'error', message: '本机更新配置无法读取，请重新保存设置' }); } },
        save: input => exclusive(async () => { await config.save(input); updater?.removeAllListeners(); updater = null; selected = null; publish({ phase: 'idle', version: '', notes: '', percent: 0, source: '', canDownload: false, message: '更新来源已保存' }); }),
        check: () => exclusive(async () => {
            if (mode === 'development') { publish({ phase: 'idle', message: '开发预览不执行远程更新；请在打包后的软件中检查' }); return; }
            if (mode === 'unsupported') { publish({ phase: 'idle', message: '当前平台暂不支持应用内更新，请通过项目主页获取新版本' }); return; }
            if (state.phase === 'downloaded') return;
            await config.ready.catch(() => {});
            updater?.removeAllListeners(); updater = null; selected = null;
            const source = config.read().source ?? 'website';
            const sources = source === 'auto' ? ['website', 'github'] : [source];
            publish({ phase: 'checking', version: '', notes: '', percent: 0, source: '', canDownload: false, message: '正在检查' + sources.map(s => s === 'website' ? '网站' : 'GitHub').join('和') + '更新…' });
            const results = await Promise.allSettled(sources.map(async source => {
                if (source === 'github') {
                    const release = await getGithubRelease();
                    return { ...release, version: releaseVersion(release.version), source, available: compareReleaseVersions(release.version, version) > 0 };
                }
                const candidate = configureUpdater(makeUpdater, config.feed());
                const { info, available } = await probeUpdater(candidate);
                const stable = parseReleaseVersion(info.version);
                return { source, version: stable?.version ?? info.version, available: !!stable && available && compareReleaseVersions(info.version, version) > 0, notes: releaseNotes(info.releaseNotes), page: config.page(), updater: candidate };
            }));
            const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value);
            if (!valid.length) { fail(results[0].reason); return; }
            const failures = sources.filter((_, i) => results[i].status === 'rejected').map(s => s === 'website' ? '网站' : 'GitHub');
            const suffix = failures.length ? `；${failures.join('、')}暂不可用，本次仅检查了另一来源` : '';
            selected = valid.filter(r => r.available).sort((a, b) => compareReleaseVersions(b.version, a.version))[0];
            if (!selected) {
                publish({ phase: 'current', message: (failures.length ? '可用来源未发现新版本' : '当前已是最新版本') + suffix, checkedAt: new Date().toISOString() }); return;
            }
            const canDownload = mode === 'installed' && Boolean(selected.updater || selected.feed);
            if (selected.updater) bindDownload(selected.updater);
            const label = selected.source === 'website' ? '网站' : 'GitHub';
            publish({ phase: 'available', version: selected.version, notes: selected.notes, source: selected.source, canDownload,
                message: `发现新版本 ${selected.version}（${label}）` + (canDownload ? '' : '，请从下载页获取') + suffix, checkedAt: new Date().toISOString() });
        }),
        download: () => exclusive(async () => {
            if (mode !== 'installed' || state.phase !== 'available' || !state.canDownload || !selected) throw Error('请先在安装版中检查到可下载更新');
            publish({ phase: 'downloading', percent: 0, message: '正在下载更新…' });
            try {
                if (!updater) {
                    const candidate = configureUpdater(makeUpdater, selected.feed);
                    const { info, available } = await probeUpdater(candidate);
                    if (!available || compareReleaseVersions(info.version, selected.version) !== 0) throw Error('Update version mismatch');
                    bindDownload(candidate);
                }
                await updater.downloadUpdate();
            } catch (e) { fail(e); }
        }),
        install: () => exclusive(async () => {
            if (mode !== 'installed' || state.phase !== 'downloaded' || !updater) throw Error('更新尚未下载并校验完成');
            if (!await confirmInstall()) return;
            installing = true; publish({ phase: 'installing', message: '正在重启安装…' });
            try { install(updater); } catch (e) { fail(e); }
            if (state.phase === 'error') installing = false;
        }),
        openPage: () => openPage(selected?.page || config.page()),
        dispose() { disposed = true; },
    };
}
module.exports = { createUpdateHost };
