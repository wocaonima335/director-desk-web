import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';

const require = createRequire(import.meta.url);
const { installFilePermissions } = require('../desktop/file-permissions.cjs');
await fs.mkdir('tmp', { recursive: true });
const root = await fs.mkdtemp(path.resolve('tmp/file-permissions-desktop-'));
const profile = path.join(root, 'profile'), filename = path.join(root, 'permission-export.mp4');
await fs.mkdir(profile);
await fs.writeFile(path.join(profile, 'file-locations.json'), JSON.stringify({
    projects: path.join(root, 'projects'), exports: path.join(root, 'exports'),
}));
await fs.writeFile(filename, '');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'),
    args: [path.resolve(process.env.DIRECTOR_TEST_APP || '.audit/desktop-app'), `--director-test-profile=${profile}`], env });
let clipboardSaved = false, page;
const errors = [];
const installCurrentPermissions = () => app.evaluate(({ BrowserWindow }, source) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    // The shipped, dependency-free function is supplied by this local test driver.
    const install = Function(`return (${source})`)();
    install(contents.session, contents);
}, installFilePermissions.toString());
try {
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.application-menu');
    await app.evaluate(async ({ clipboard }) => {
        // Materialize every format before modifying the clipboard; never persist it.
        globalThis.filePermissionsClipboard = await Promise.all((await clipboard.read()).map(async item =>
            Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))));
    });
    clipboardSaved = true;
    await installCurrentPermissions();
    await page.evaluate(() => {
        window.filePermissionsTest = { handle: null, done: false, error: null };
        const target = document.createElement('div');
        target.id = 'file-permissions-paste-target'; target.contentEditable = 'true'; target.tabIndex = 0;
        target.addEventListener('paste', event => {
            event.preventDefault();
            event.clipboardData.items[0].getAsFileSystemHandle().then(
                handle => { window.filePermissionsTest.handle = handle; window.filePermissionsTest.done = true; },
                error => { window.filePermissionsTest.error = error.message; window.filePermissionsTest.done = true; });
        }, { once: true });
        document.body.append(target); target.focus();
    });
    // Electron's official chromium-spec.ts obtains real handles through native paste:
    // https://github.com/electron/electron/blob/main/spec/chromium-spec.ts
    await app.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem }, uri) => {
        await clipboard.write([new ClipboardItem({ 'text/uri-list': uri })]);
        const window = BrowserWindow.getAllWindows()[0]; window.focus(); window.webContents.focus();
        await window.webContents.executeJavaScript('document.getElementById("file-permissions-paste-target").focus(); true');
        window.webContents.paste();
    }, pathToFileURL(filename).href);
    await page.waitForFunction(() => window.filePermissionsTest.done, null, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => ({ error: window.filePermissionsTest.error,
        real: window.filePermissionsTest.handle instanceof FileSystemFileHandle,
        name: window.filePermissionsTest.handle?.name })), { error: null, real: true, name: path.basename(filename) });
    await page.evaluate(() => document.getElementById('file-permissions-paste-target').remove());

    await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        globalThis.filePermissionsOldChecks = [];
        const trusted = (sender, permission, origin) => sender === contents && !contents.isDestroyed()
            && contents.getURL() === 'director://app/' && permission === 'fileSystem'
            && (origin === 'director://app' || origin === 'director://app/');
        contents.session.setPermissionCheckHandler((sender, permission, origin) => {
            const allowed = trusted(sender, permission, origin);
            globalThis.filePermissionsOldChecks.push({ nullSender: sender === null, permission, origin, allowed });
            return allowed;
        });
        contents.session.setPermissionRequestHandler((sender, permission, callback, details) => callback(trusted(sender, permission, details.requestingUrl)));
    });
    const oldError = await page.evaluate(async () => {
        try { const stream = await window.filePermissionsTest.handle.createWritable(); await stream.abort(); return null; }
        catch (error) { return error.name; }
    });
    assert.equal(oldError, 'NotAllowedError');
    assert((await app.evaluate(() => globalThis.filePermissionsOldChecks)).some(check =>
        check.nullSender && check.permission === 'fileSystem' && !check.allowed));

    await installCurrentPermissions();
    await page.evaluate(async () => {
        const stream = await window.filePermissionsTest.handle.createWritable();
        await stream.write('permission-restored'); await stream.close();
    });
    assert.equal(await fs.readFile(filename, 'utf8'), 'permission-restored');
    // Only the chooser result is supplied; the handle, stream, encoder and disk write stay real.
    await page.evaluate(() => { window.showSaveFilePicker = async () => window.filePermissionsTest.handle; });
    await page.locator('.header-actions [data-act="export"]').click();
    await page.locator('#export-end').fill('.25');
    await page.locator('#export-size').selectOption('640');
    await page.locator('#export-fps').selectOption('24');
    await page.locator('#export-save').selectOption('disk');
    await page.locator('[data-act="export-start"]').click();
    await page.waitForSelector('.export-modal', { state: 'detached', timeout: 60000 });
    const bytes = await fs.readFile(filename);
    const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS });
    let frames = 0, width, height;
    try {
        const track = await input.getPrimaryVideoTrack(); assert(track);
        width = track.displayWidth; height = track.displayHeight;
        for await (const packet of new EncodedPacketSink(track).packets()) { assert(packet); frames++; }
        assert.equal(frames, 6); assert.equal(width, 640); assert.equal(height, 360);
    } finally { input.dispose(); }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, oldError, actualHandle: true, writeClosed: true,
        video: { bytes: bytes.length, frames, width, height },
        scope: 'Real native-paste handle and export stream; save-picker UI is not automated.' }));
} catch (error) {
    console.error('File permission desktop verification failed:', error.message, 'Page errors:', errors);
    await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    throw error;
} finally {
    try {
        if (clipboardSaved) await app.evaluate(async ({ clipboard, ClipboardItem }) => {
            const saved = globalThis.filePermissionsClipboard;
            if (saved.length) await clipboard.write(saved.map(data => new ClipboardItem(data)));
            else clipboard.clear();
            delete globalThis.filePermissionsClipboard;
        });
    } finally {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
        await app.close();
    }
}
