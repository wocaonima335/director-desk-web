// DSK-005-C: real-desktop acceptance for the DSK-005 shell + managed project lifecycle.
// Runs against the FRESHLY PREPARED app in .audit/desktop-app (never an old staging):
// Part 1 (C1) drives the REAL renderer UI with visible pointer/keyboard clicks only —
// library create (first snapshot), library reopen of that project, a simple-properties
// focal edit + library save (revision 2), a REAL process restart that must restore the
// managed project, then the import confirmation cancel (document kept) and accept
// (leaves the managed session). window.directorDesktop.dsk() is used ONLY to cross-check
// persisted state, never to substitute a click.
// Part 2 (C3) is the window matrix: 1280x720 and 1920x1080 at zoom 100/125/150. Every cell
// records outer bounds, workArea, viewport, devicePixelRatio and zoomFactor, then walks the
// simple shell (preview play/pause, shot card, simple properties, error/gate visibility),
// the keyboard-driven mode toggle (advanced: original timeline/inspector reachable), the
// file menu and the project library. ZOOM IS PROGRAMMATIC (webContents.setZoomFactor):
// this is NOT a Windows DPI verification.
// 1920x1080 rule: if the requested window does not fit entirely (all four edges) inside a
// SINGLE display workArea, that cell is recorded UNVERIFIED — the target is never shrunk
// and no OS/display setting is touched. Only unverified cells keep exit 0 alive; every
// other failure is a non-zero exit.
// Shutdown follows the existing desktop-test precedent (test-files-desktop.mjs /
// test-dsk005-a-desktop.mjs): the native three-choice exit dialog is stubbed at runtime
// (product untouched), close failures/timeouts and unhandledRejections are FAILURES, and
// the electron child 'exit' event is ALWAYS awaited before the runner decides its code.
// Independent profile + storage directory per launch; tmp artifacts are removed on success.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import esbuild from 'esbuild';

const root = path.resolve('.');
const appDir = path.resolve('.audit/desktop-app');
const require = createRequire(import.meta.url);

const PROJECT_NAME = 'DSK-005-C 受管工程';
const IMPORT_NAME = 'DSK-005-C 导入工程';
const LEASE_TTL_MS = 4000; // unpackaged test build honors DIRECTOR_STORAGE_LEASE_TTL_MS
const CLOSE_TIMEOUT_MS = 30000;
const EXIT_TIMEOUT_MS = 30000;
// 2 lifecycle instances + 6 matrix cells; the storage desktop script uses 600s for more.
const DEADLINE_MS = 900000;
const MATRIX = [
    { width: 1280, height: 720, zoom: 1 },
    { width: 1280, height: 720, zoom: 1.25 },
    { width: 1280, height: 720, zoom: 1.5 },
    { width: 1920, height: 1080, zoom: 1 },
    { width: 1920, height: 1080, zoom: 1.25 },
    { width: 1920, height: 1080, zoom: 1.5 },
];

const failures = [];
const fail = message => {
    console.error('DESKTOP-UI-FAIL: ' + message);
    failures.push(message);
    process.exitCode = 1;
};
const msg = error => (error instanceof Error ? (error.stack || error.message) : String(error));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

let unhandledSeen = false;
let unhandledDetail = '';
process.on('unhandledRejection', reason => {
    unhandledSeen = true; // recorded, never swallowed — fails the run at the end
    unhandledDetail = reason instanceof Error ? (reason.stack || String(reason)) : String(reason);
});

// Prepared-app freshness gate: the staged payload must be the CURRENT tree, including the
// DSK-005 shell (an old .audit/desktop-app must not pass for this task).
for (const file of ['package.json', 'desktop/main.cjs', 'desktop/integration.cjs', 'dist/index.html']) {
    if (!fsSync.existsSync(path.join(appDir, file))) fail(`missing prepared file ${file} (run npm run desktop:prepare first)`);
}
async function listJsFiles(dir) {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await listJsFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}
let stagedMarker = false;
if (!process.exitCode) {
    for (const file of await listJsFiles(path.join(appDir, 'dist'))) {
        if ((await fs.readFile(file, 'utf8')).includes('director-mode-toggle') && (await fs.readFile(file, 'utf8')).includes('director-shot-list')) { stagedMarker = true; break; }
    }
    if (!stagedMarker) fail('staged dist lacks the DSK-005 shell markers (director-mode-toggle / director-shot-list); .audit/desktop-app is stale — run npm run desktop:prepare');
}
if (process.exitCode) process.exit(process.exitCode);

// Real SceneDocument via the production engine factory (storage-script precedent), used as
// the .director import fixture for the confirm/cancel paths.
const helperFile = path.join(root, 'tmp', `dsk-ui-helper-${process.pid}.cjs`);
await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
await esbuild.build({
    stdin: { contents: [
        "export { readSceneDocument } from './src/scenes/sequence-project.ts';",
        "export { demoProject } from './src/model.ts';",
    ].join('\n'), resolveDir: root, loader: 'ts' },
    outfile: helperFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
process.on('exit', () => { try { fsSync.rmSync(helperFile, { force: true }); } catch { /* best effort */ } });
const helper = require(helperFile);
const importDocument = helper.readSceneDocument(helper.demoProject());
importDocument.name = IMPORT_NAME;
const importPath = path.join(root, 'tmp', `dsk-005-ui-import-${process.pid}.director`);
await fs.writeFile(importPath, JSON.stringify(importDocument), 'utf8');
// Second copy for the accept step: re-selecting the IDENTICAL path does not re-fire the file
// input's change event (Chromium skips an unchanged file selection), so the second import
// selects an equal-content copy under a different name — exactly like a real user re-picking
// the file in the picker.
const importPath2 = path.join(root, 'tmp', `dsk-005-ui-import-2nd-${process.pid}.director`);
await fs.writeFile(importPath2, JSON.stringify(importDocument), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DIRECTOR_STORAGE_LEASE_TTL_MS = String(LEASE_TTL_MS);

let launched = 0;
let exitConfirmed = 0;

async function launchShell(profile, storageDir) {
    const app = await electron.launch({
        executablePath: require('electron'),
        args: [appDir, `--director-test-profile=${profile}`, `--director-storage-dir=${storageDir}`],
        env,
    });
    launched += 1;
    // Registered BEFORE any close attempt: kill() returning is not proof of exit.
    const exited = new Promise(resolve => app.process().once('exit', (code, signal) => resolve({ code, signal })));
    const page = await app.firstWindow();
    page.on('dialog', () => { }); // files-desktop precedent: native will-prevent-unload is main-process territory
    await page.waitForSelector('.application-menu', { timeout: 60000 });
    return { app, page, exited };
}

// Kill ONLY this test's process tree (playwright's child is a cmd.exe wrapper on Windows).
function killTree(child) {
    if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        child.kill('SIGKILL');
    }
}

// Product close path with the existing tests' precedent: stub the native confirm dialog
// (choice 1 = 不保存退出), then close the window via setTimeout so the evaluate settles.
// Never swallowed: a failure or timeout is a recorded failure and escalates to killTree,
// and the child 'exit' event is awaited either way.
async function closeProduct(session, label) {
    const closeEvent = session.app.waitForEvent('close', { timeout: CLOSE_TIMEOUT_MS });
    await session.app.evaluate(({ dialog, BrowserWindow }) => {
        dialog.showMessageBoxSync = () => 1;
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
    });
    await closeEvent;
}
async function closeShell(session, label) {
    if (!session) return;
    let closed = false;
    try {
        await withTimeout(closeProduct(session, label), CLOSE_TIMEOUT_MS + 5000, `${label} product close path`);
        closed = true;
    } catch (error) {
        fail(`${label}: product close failed or timed out: ${msg(error)}`);
        try { killTree(session.app.process()); } catch (killError) {
            fail(`${label}: killTree after failed close threw: ${msg(killError)}`);
        }
    }
    try {
        const exit = await withTimeout(session.exited, EXIT_TIMEOUT_MS, `${label} electron child exit`);
        exitConfirmed += 1;
        console.error(`${label}: electron child exited (code=${exit.code} signal=${exit.signal})${closed ? '' : ' — via taskkill after a failed close'}`);
        if (!closed) fail(`${label}: close failed or timed out; the process tree only ended via taskkill`);
    } catch (error) {
        fail(`${label}: electron child process did not exit: ${msg(error)}`);
    }
}

const waitToast = (page, substr, timeout = 15000) => page.waitForFunction(
    substr => [...document.querySelectorAll('#toasts .toast')].some(toast => (toast.textContent ?? '').includes(substr)),
    substr, { timeout });
const waitSaveStatusStarts = (page, prefix, timeout = 30000) => page.waitForFunction(
    prefix => (document.querySelector('#save-status')?.textContent ?? '').startsWith(prefix),
    prefix, { timeout });
const waitSaveStatusIncludes = (page, substr, timeout = 15000) => page.waitForFunction(
    substr => (document.querySelector('#save-status')?.textContent ?? '').includes(substr),
    substr, { timeout });

// Debug-call cross-checks only (never a click substitute): the real preload bridge.
const must = (condition, label) => { if (!condition) throw new Error(label); };
async function bootstrapOf(page) {
    const reply = await page.evaluate(async () => await window.directorDesktop.dsk('storage.v1.session.bootstrap', {}));
    if (!reply?.ok) throw new Error('session.bootstrap query failed: ' + JSON.stringify(reply));
    return reply.data;
}
async function statusOf(page, projectId) {
    const reply = await page.evaluate(async id => await window.directorDesktop.dsk('project.status', { projectId: id }), projectId);
    if (!reply?.ok) throw new Error('project.status query failed: ' + JSON.stringify(reply));
    return reply.data;
}
async function openLibrary(page) {
    await page.click('#project-library-open');
    await page.waitForSelector('#project-library', { timeout: 15000 });
}

// --- Part 1 (C1): managed lifecycle over REAL UI clicks ----------------------------------
async function runLifecycle() {
    const steps = [];
    const dir = path.join(root, 'tmp', `dsk-005-ui-main-${process.pid}`);
    const storageDir = path.join(dir, 'storage'), profile = path.join(dir, 'profile');
    for (const d of [storageDir, profile]) await fs.mkdir(d, { recursive: true });

    // C1a: create the managed project + first snapshot through the library UI.
    let session = await launchShell(profile, storageDir);
    let projectId = '';
    try {
        await session.page.waitForSelector('#director-mode-toggle', { timeout: 30000 }); // shell mounted, simple default
        await openLibrary(session.page);
        await session.page.fill('#library-new-name', PROJECT_NAME);
        await session.page.click('[data-library-act="create"]');
        await waitToast(session.page, '已创建受管项目', 30000);
        await waitSaveStatusStarts(session.page, '受管项目：', 30000);
        // The success closeModal runs while ctx.busy is still set, so modal-pages refuses it and
        // the library modal can stay open (same family as the storage script's 6.4b note). Close
        // it with its REAL footer button when present — never force.
        if (await session.page.locator('#project-library').count()) {
            await session.page.click('.modal-footer [data-act="close-modal"]');
            await session.page.waitForSelector('#project-library', { state: 'detached', timeout: 10000 });
        }
        const boot = await bootstrapOf(session.page);
        must(boot.mode === 'managed' && !!boot.projectId, `create must persist the managed choice, got ${JSON.stringify(boot)}`);
        projectId = boot.projectId;
        const status = await statusOf(session.page, projectId);
        must(status.revision === 1, `the first snapshot must be revision 1, got ${status.revision}`);
        must(status.lease.owned === true, 'the creating session must own the lease after create');
        steps.push('create-first-snapshot(rev1)');
        console.log(`LIFECYCLE-CREATE-OK: managed project "${PROJECT_NAME}" created with first snapshot (revision 1) via real library clicks`);

        // C1b: open the same project from the library. The controller may reuse the live
        // session (已重开) or run a full open (已打开) — both are the real open action.
        await openLibrary(session.page);
        await session.page.click(`[data-library-open="${projectId}"]`);
        await session.page.waitForFunction(
            () => [...document.querySelectorAll('#toasts .toast')].some(toast => /已(重开|打开)受管项目/.test(toast.textContent ?? '')),
            undefined, { timeout: 30000 });
        must((await statusOf(session.page, projectId)).revision === 1,
            'reopening the project from the library must not change its revision');
        steps.push('reopen-from-library');
        console.log('LIFECYCLE-REOPEN-OK: the project was reopened from the library via a real row click (document reloaded, managed session active)');

        // C1c: real edit through the simple properties (shot card selects the camera, focal
        // input dirties the document), then a REAL library save that must land revision 2.
        await session.page.click('[data-director-shot="1"]');
        await session.page.waitForFunction(
            () => document.querySelector('[data-director-shot="1"]')?.getAttribute('aria-current') === 'true',
            undefined, { timeout: 10000 });
        must((await session.page.textContent('#director-shot-summary'))?.includes('第 2 镜'),
            'the shot card click must move the simple properties summary to shot 2');
        await session.page.fill('#director-focal-input', '33');
        await session.page.click('#director-focal-apply');
        await waitSaveStatusIncludes(session.page, '未保存', 10000);
        await openLibrary(session.page);
        await session.page.click('[data-library-act="save"]');
        await waitToast(session.page, '快照已保存到项目库（第 2 版）', 30000);
        must((await statusOf(session.page, projectId)).revision === 2,
            'the second save must land revision 2 in the library');
        steps.push('save-revision-2');
        console.log('LIFECYCLE-SAVE-OK: shot-card click + focal edit through the simple properties dirtied the document; the library save committed revision 2');
    } finally {
        await closeShell(session, 'lifecycle/instance-1');
    }

    // C1d: REAL restart (same profile + storage) must restore the managed project.
    await sleep(LEASE_TTL_MS + 1500); // let the killed writer's lease expire (storage-script precedent)
    session = await launchShell(profile, storageDir);
    try {
        await waitSaveStatusStarts(session.page, '受管项目：', 30000);
        const boot = await bootstrapOf(session.page);
        must(boot.mode === 'managed' && boot.projectId === projectId,
            `the restart must restore the managed project, got ${JSON.stringify(boot)}`);
        must((await statusOf(session.page, projectId)).revision === 2,
            'the restored project must still be at revision 2');
        steps.push('restart-restores-managed(rev2)');
        console.log('LIFECYCLE-RESTART-OK: a real process restart restored the managed project (revision 2) through the startup path');

        // C1e: import CONFIRMATION CANCEL keeps the original document, dirty state and choice.
        await session.page.click('[data-director-shot="1"]');
        await session.page.fill('#director-focal-input', '34');
        await session.page.click('#director-focal-apply');
        await waitSaveStatusIncludes(session.page, '未保存', 10000);
        const titleBefore = await session.page.title();
        await session.page.setInputFiles('#project-file', importPath);
        await session.page.waitForSelector('#managed-switch-confirm', { timeout: 20000 });
        await session.page.click('#managed-switch-cancel');
        await session.page.waitForSelector('#managed-switch-confirm', { state: 'detached', timeout: 10000 });
        must((await session.page.title()) === titleBefore, 'cancelling the import must keep the current document');
        must(((await session.page.textContent('#save-status')) ?? '').includes('未保存'),
            'cancelling the import must keep the unsaved marker');
        must((await statusOf(session.page, projectId)).revision === 2,
            'a cancelled import must not write into the managed project');
        must((await bootstrapOf(session.page)).mode === 'managed', 'cancelling the import must keep the managed choice');
        steps.push('import-cancel-keeps-document');
        console.log('LIFECYCLE-IMPORT-CANCEL-OK: the import confirmation was cancelled — document, dirty state and managed choice untouched');

        // C1f: import CONFIRMATION ACCEPT leaves the managed session; the library is untouched.
        await session.page.setInputFiles('#project-file', importPath2);
        await session.page.waitForSelector('#managed-switch-confirm', { timeout: 20000 });
        await session.page.click('#managed-switch-accept');
        await session.page.waitForFunction(name => document.title.includes(name), IMPORT_NAME, { timeout: 20000 });
        // The leave writes 普通会话（未管理） into #save-status, but applyDocument immediately
        // overwrites it (storage-script 6.2 precedent) — the persisted bootstrap mode + title
        // are the reliable leave evidence here.
        must((await bootstrapOf(session.page)).mode === 'unmanaged',
            'accepting the import must persist the unmanaged choice');
        must((await statusOf(session.page, projectId)).revision === 2,
            'imported content must never write into the managed project');
        steps.push('import-accept-leaves-managed');
        console.log('LIFECYCLE-IMPORT-ACCEPT-OK: the import confirmation was accepted — left the managed session (unmanaged persisted); the library project stayed at revision 2');
    } finally {
        await closeShell(session, 'lifecycle/instance-2');
    }
    await fs.rm(dir, { recursive: true, force: true });
    return steps;
}

// --- Part 2 (C3): window matrix -----------------------------------------------------------
function withinWorkArea(bounds, workArea) {
    return bounds.x - workArea.x >= 0 && bounds.y - workArea.y >= 0
        && workArea.x + workArea.width - (bounds.x + bounds.width) >= 0
        && workArea.y + workArea.height - (bounds.y + bounds.height) >= 0;
}
async function placeWindow(session, width, height) {
    const displays = await session.app.evaluate(({ screen }) =>
        screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor })));
    const fitting = displays.find(d => d.workArea.width >= width && d.workArea.height >= height);
    const workArea = (fitting ?? displays[0]).workArea; // no fitting display: still request the FULL size
    await session.app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0].setBounds(bounds);
    }, {
        x: workArea.x + Math.floor((workArea.width - width) / 2),
        y: workArea.y + Math.floor((workArea.height - height) / 2),
        width, height,
    });
    return { displays, fitting: !!fitting };
}
async function waitForStableBounds(session, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastKey = null, stable = 0, last = null;
    while (Date.now() < deadline) {
        last = await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
        const key = JSON.stringify(last);
        if (key === lastKey) { if (++stable >= 5) return last; } else { lastKey = key; stable = 0; }
        await sleep(100);
    }
    return last;
}
async function setZoom(session, zoom) {
    await session.app.evaluate(({ BrowserWindow }, z) => {
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z);
    }, zoom);
    const deadline = Date.now() + 10000;
    for (;;) {
        const current = await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
        if (Math.abs(current - zoom) < 1e-6) return current;
        if (Date.now() > deadline) throw new Error(`zoomFactor never reached ${zoom} (last ${current})`);
        await sleep(100);
    }
}
async function measure(session) {
    const state = await session.app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (!w) return null;
        const bounds = w.getBounds();
        const display = screen.getDisplayMatching(bounds);
        return {
            outerBounds: bounds,
            workArea: display.workArea,
            hostingDisplayId: display.id,
            zoomFactor: w.webContents.getZoomFactor(),
            visible: w.isVisible(),
            minimized: w.isMinimized(),
        };
    });
    if (!state) throw new Error('the main BrowserWindow disappeared before measurement');
    return state;
}

// One smoke walk per matrix cell, all REAL pointer/keyboard interaction.
async function smokeSimpleShell(page) {
    const checks = [];
    const note = (name, ok) => {
        checks.push({ name, ok: !!ok });
        if (!ok) throw new Error('smoke check failed: ' + name);
    };
    // Simple shell layout + preview.
    await page.waitForFunction(() => document.getElementById('app')?.dataset.directorShell === 'simple', undefined, { timeout: 15000 });
    note('simple-shell-active', true);
    note('shot-rail-visible', await page.locator('#director-rail-shots').isVisible());
    note('shot-card-visible', await page.locator('[data-director-shot="0"]').isVisible());
    note('shot-viewport-visible', await page.locator('.viewports .shot-panel').isVisible());
    note('play-button-visible', await page.locator('[data-act="play"]').isVisible());
    note('task-note-visible', await page.locator('#director-task-note').isVisible());
    await page.click('[data-act="play"]');
    await page.waitForFunction(() => document.querySelector('[data-act="play"]')?.getAttribute('aria-label') === '暂停', undefined, { timeout: 10000 });
    note('simple-preview-plays', true);
    await page.click('[data-act="play"]');
    await page.waitForFunction(() => document.querySelector('[data-act="play"]')?.getAttribute('aria-label') === '播放', undefined, { timeout: 10000 });
    note('simple-preview-pauses', true);
    // Shot card click (view-only action) + simple properties summary.
    await page.click('[data-director-shot="1"]');
    await page.waitForFunction(
        () => document.querySelector('[data-director-shot="1"]')?.getAttribute('aria-current') === 'true',
        undefined, { timeout: 10000 });
    note('shot-card-click-marks-current', true);
    note('properties-follow-shot', (await page.textContent('#director-shot-summary'))?.includes('第 2 镜'));
    note('focal-input-synced', Number.isFinite(Number(await page.inputValue('#director-focal-input'))));
    // Error visibility: out-of-range focal is refused with a toast; the gate line renders.
    await page.fill('#director-focal-input', '999');
    await page.click('#director-focal-apply');
    await waitToast(page, '焦距需在', 10000);
    note('error-toast-visible', true);
    note('gate-line-visible', (await page.textContent('[data-director-status="gate"]'))?.startsWith('整档禁写'));
    // Mode toggle by KEYBOARD: Enter → advanced (original timeline/inspector reachable), Space → simple.
    await page.focus('#director-mode-toggle');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('app')?.dataset.directorShell === 'advanced', undefined, { timeout: 10000 });
    note('keyboard-enter-to-advanced', true);
    note('advanced-sidebar', await page.locator('.sidebar').isVisible());
    note('advanced-inspector', await page.locator('.inspector').isVisible());
    note('advanced-timeline', await page.locator('#timeline-content').isVisible());
    note('advanced-add-camera', await page.locator('[data-act="add-camera"]').isVisible());
    await page.keyboard.press(' ');
    await page.waitForFunction(() => document.getElementById('app')?.dataset.directorShell === 'simple', undefined, { timeout: 10000 });
    note('keyboard-space-to-simple', await page.locator('#director-rail-shots').isVisible());
    // File menu.
    await page.click('[data-menu="file"]');
    await page.waitForSelector('#application-menu-file', { state: 'visible', timeout: 10000 });
    note('file-menu-opens', await page.locator('#application-menu-file [data-act="scene-templates"]').isVisible());
    await page.click('[data-menu="file"]');
    await page.waitForSelector('#application-menu-file', { state: 'hidden', timeout: 10000 });
    note('file-menu-closes', true);
    // Project library modal.
    await page.click('#project-library-open');
    await page.waitForSelector('#project-library', { timeout: 10000 });
    note('library-modal-opens', await page.locator('#project-library').isVisible());
    await page.click('.modal-footer [data-act="close-modal"]');
    await page.waitForSelector('#project-library', { state: 'detached', timeout: 10000 });
    note('library-modal-closes', true);
    return checks;
}

async function runMatrix() {
    const cells = [];
    for (let index = 0; index < MATRIX.length; index++) {
        const cell = MATRIX[index];
        const label = `matrix[${index}] ${cell.width}x${cell.height}@${Math.round(cell.zoom * 100)}%`;
        const record = {
            label,
            request: { width: cell.width, height: cell.height, zoomPercent: Math.round(cell.zoom * 100) },
            outerBounds: null, workArea: null, viewport: null, devicePixelRatio: null, zoomFactor: null,
            fullyWithinWorkArea: false, unverified: false, note: '', checks: [],
        };
        cells.push(record);
        const dir = path.join(root, 'tmp', `dsk-005-ui-matrix-${process.pid}-${index}`);
        const storageDir = path.join(dir, 'storage'), profile = path.join(dir, 'profile');
        for (const d of [storageDir, profile]) await fs.mkdir(d, { recursive: true });
        let session = null;
        try {
            session = await launchShell(profile, storageDir);
            await session.page.waitForSelector('#director-shot-list [data-director-shot]', { timeout: 30000 });
            await placeWindow(session, cell.width, cell.height);
            await waitForStableBounds(session);
            record.zoomFactor = await setZoom(session, cell.zoom);
            const measured = await measure(session);
            record.outerBounds = measured.outerBounds;
            record.workArea = measured.workArea;
            // page.viewportSize() is null under Electron; the CSS viewport is the real signal.
            record.viewport = await session.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
            record.devicePixelRatio = await session.page.evaluate(() => window.devicePixelRatio);
            record.fullyWithinWorkArea = withinWorkArea(measured.outerBounds, measured.workArea);
            must(measured.visible && !measured.minimized, `${label}: the window must be visible and not minimized`);
            if (!record.fullyWithinWorkArea) {
                if (cell.width === 1920 && cell.height === 1080) {
                    record.unverified = true;
                    record.note = 'the requested 1920x1080 window does not fit entirely inside a single workArea on this machine; cell UNVERIFIED (target not shrunk, no OS/display change, not counted as a pass)';
                    console.error(`UNVERIFIED: ${label} — ${record.note}`);
                    continue; // finally still closes the app and awaits exit
                }
                throw new Error(`window bounds ${JSON.stringify(measured.outerBounds)} are not fully inside workArea ${JSON.stringify(measured.workArea)}`);
            }
            record.checks = await smokeSimpleShell(session.page);
            console.log(`MATRIX-OK: ${label} — outer=${JSON.stringify(record.outerBounds)} workArea=${JSON.stringify(record.workArea)} viewport=${JSON.stringify(record.viewport)} dpr=${record.devicePixelRatio} zoom=${record.zoomFactor}`);
        } catch (error) {
            fail(`${label}: ${msg(error)}`);
        } finally {
            await closeShell(session, label);
            await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
        }
    }
    return cells;
}

// --- Runner --------------------------------------------------------------------------------
const lifecycleSteps = [];
let matrixCells = [];
const deadline = setTimeout(() => {
    fail(`global deadline (${DEADLINE_MS / 1000}s) exceeded`);
    process.exit(1);
}, DEADLINE_MS).unref();

try {
    lifecycleSteps.push(...await runLifecycle());
} catch (error) {
    fail('lifecycle: ' + msg(error));
}
try {
    matrixCells = await runMatrix();
} catch (error) {
    fail('matrix: ' + msg(error));
}
clearTimeout(deadline);

const unverifiedCells = matrixCells.filter(cell => cell.unverified).map(cell => cell.request);
const result = !failures.length && !unhandledSeen && launched > 0 && exitConfirmed === launched ? 'PASS' : 'FAIL';
if (result === 'FAIL') process.exitCode = 1;
for (const message of failures) console.error(`FAIL: ${message}`);
if (unhandledSeen) console.error(`FAIL: unhandledRejection observed: ${unhandledDetail}`);
if (launched === 0) console.error('FAIL: no electron process was ever launched');

const report = {
    result,
    exitCode: result === 'PASS' ? 0 : 1,
    lifecycle: { steps: lifecycleSteps },
    matrix: matrixCells,
    zoomAutomation: 'zoom 由 webContents.setZoomFactor 程序化设置；矩阵仅证明自动化缩放下的布局可达性，不是 Windows DPI 验收。',
    unverifiedCells,
    unverifiedNote: unverifiedCells.length
        ? '1920x1080 cells that cannot sit entirely inside one workArea are UNVERIFIED; this is not a pass for those cells.'
        : '',
    childExitConfirmed: `${exitConfirmed}/${launched}`,
    unhandledRejection: unhandledSeen ? unhandledDetail : null,
};
await fs.writeFile(path.join(root, 'tmp', 'dsk-005-ui-desktop-report.json'), JSON.stringify(report, null, 2), 'utf8').catch(() => { });
await fs.rm(importPath, { force: true }).catch(() => { });
await fs.rm(importPath2, { force: true }).catch(() => { });
console.log(JSON.stringify(report));
process.exit(result === 'PASS' ? 0 : 1);
