const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createUpdateHost } = require('../desktop/update-host.cjs');
const { createUpdateConfig, validateConfig } = require('../desktop/update-config.cjs');
function fixture(mode = 'installed') {
    let installCount = 0, confirmed = false, failure = false, release = true, options;
    const updates = [];
    const config = { ready: Promise.resolve(), read: () => ({ url: 'https://example.com/updates/', automatic: true }), feed: () => ({ provider: 'generic', url: 'https://example.com/updates/' }), save: async () => {}, page: () => 'https://example.com/' };
    const host = createUpdateHost({ version: '1.0.0', mode, config, send: s => updates.push(s), confirmInstall: async () => confirmed, install: () => installCount++, openPage: async () => {},
        makeUpdater: feed => {
            const updater = new EventEmitter(); options = updater; assert.equal(feed.provider, 'generic');
            updater.checkForUpdates = async () => { updater.emit('checking-for-update'); await new Promise(r => setTimeout(r, 3)); updater.emit(release ? 'update-available' : 'update-not-available', { version: '1.1.0', releaseNotes: '<b>plain text</b>' }); };
            updater.downloadUpdate = async () => { updater.emit('download-progress', { percent: 47 }); if (failure) throw Error('sha512 checksum mismatch with sensitive path'); updater.emit('update-downloaded'); };
            return updater;
        } });
    return { host, updates, options: () => options, installed: () => installCount, confirm: () => { confirmed = true; }, fail: () => { failure = true; }, noRelease: () => { release = false; } };
}
test('updates separate checking, downloading and user-confirmed installation; no automatic install on quit', async () => {
    const f = fixture(); await f.host.initialize(); await f.host.check(); assert.equal(f.host.read().phase, 'available');
    assert.equal(f.options().autoDownload, false); assert.equal(f.options().autoInstallOnAppQuit, false); assert.equal(f.options().allowDowngrade, false);
    await assert.rejects(f.host.install(), /尚未下载/); await f.host.download(); assert.equal(f.host.read().phase, 'downloaded');
    assert.ok(f.updates.some(s => s.percent === 47)); await f.host.install(); assert.equal(f.installed(), 0);
    f.confirm(); await f.host.install(); assert.equal(f.installed(), 1);
});
test('failed integrity cannot install and errors do not expose original provider details', async () => {
    const f = fixture(); await f.host.check(); f.fail(); await f.host.download();
    assert.equal(f.host.read().phase, 'error'); assert.match(f.host.read().message, /校验失败/);
    assert.equal(JSON.stringify(f.updates).includes('sensitive'), false); f.confirm(); await assert.rejects(f.host.install()); assert.equal(f.installed(), 0);
});
test('concurrent operations are rejected and portable/development modes never install', async () => {
    const f = fixture(); const pending = f.host.check(); await assert.rejects(f.host.check(), /正在进行/); await assert.rejects(f.host.save({}), /正在进行/); await pending;
    const portable = fixture('portable'); await portable.host.check(); assert.equal(portable.host.read().phase, 'available'); await assert.rejects(portable.host.download()); await assert.rejects(portable.host.install());
    const dev = fixture('development'); await dev.host.check(); assert.equal(dev.options(), undefined);
    const unsupported = fixture('unsupported'); await unsupported.host.check(); assert.equal(unsupported.options(), undefined);
    assert.match(unsupported.host.read().message, /暂不支持/); await assert.rejects(unsupported.host.download()); await assert.rejects(unsupported.host.install());
    f.noRelease(); await f.host.check(); assert.equal(f.host.read().phase, 'current'); assert.equal(f.host.read().version, '');
});
test('update settings persist only explicit HTTPS origin settings and reject embedded credentials', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'director-update-test-'));
    try {
        const store = createUpdateConfig(directory); await store.ready;
        await store.save({ url: 'https://example.com/files', automatic: false, token: 'ignored-field' });
        const second = createUpdateConfig(directory); await second.ready; assert.deepEqual(second.read(), { url: 'https://example.com/files/', automatic: false, source: 'auto' });
        assert.equal((await fs.readFile(path.join(directory, 'updates.json'), 'utf8')).includes('ignored-field'), false);
        for (const url of ['http://example.com/', 'file:///data', 'https://user:password@example.com/', 'https://example.com/?key=secret']) assert.throws(() => validateConfig({ url, automatic: true }));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
