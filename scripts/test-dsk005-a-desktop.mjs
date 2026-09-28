// DSK-005-A-VERIFY-CLOSEOUT: real-window geometry verification for the freshly
// prepared desktop payload (.audit/desktop-app). Launches via playwright-core
// _electron, moves the main window to 1920x1080 inside ONE display's workArea,
// then verifies exact size, zoom factor 1, visibility, and full containment
// within that same display's workArea (per-edge comparison, negative
// coordinates allowed, no cross-display area summing). Read-only against the
// product: never changes OS settings, never fullscreen/kiosk/hides, never
// touches zoom, never edits product files. Exits 0 only when all measurements
// pass AND the electron child process is confirmed exited; exit 2 = BLOCKED
// (no single workArea fits 1920x1080); any other failure exits 1. close/kill
// failures and timeouts are failures, never swallowed.
//
// Shutdown follows the existing desktop-test precedent (test-files-desktop.mjs,
// test-dsk-rp2-exit-desktop.mjs): desktop/files.cjs confirmExit() shows the
// native three-choice dialog even when idle, so the main-process dialog is
// stubbed at runtime (product files untouched) and the window is closed via
// setTimeout so the evaluate settles first. On Windows playwright's child is a
// cmd.exe wrapper, so a stalled close escalates to a taskkill /T of THIS test's
// process tree only — and kill is never treated as exit: the child 'exit' event
// is awaited either way.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const TARGET_W = 1920;
const TARGET_H = 1080;
const CLOSE_TIMEOUT_MS = 30000;
const EXIT_TIMEOUT_MS = 30000;

const failures = [];
const fail = message => failures.push(message);
let unhandledSeen = false;
let unhandledDetail = '';
process.on('unhandledRejection', reason => {
    unhandledSeen = true;
    unhandledDetail = reason instanceof Error ? (reason.stack || String(reason)) : String(reason);
});

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs inside the electron main process: window state + every display's geometry.
async function readWindowState(app) {
    return app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0];
        const displays = screen.getAllDisplays().map(d => ({
            id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
        }));
        if (!w) return { missing: true, displays };
        const bounds = w.getBounds();
        return {
            missing: false,
            bounds,
            visible: w.isVisible(),
            minimized: w.isMinimized(),
            zoom: w.webContents.getZoomFactor(),
            hostingDisplayId: screen.getDisplayMatching(bounds).id,
            displays,
        };
    });
}

// Bounds and zoom can lag a frame behind setBounds; require several identical
// consecutive reads (or give up after the timeout and let the checks judge).
async function waitForStableWindowState(app, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastKey = null, stableCount = 0, last = null;
    while (Date.now() < deadline) {
        last = await readWindowState(app);
        const key = JSON.stringify(last.bounds) + '/' + last.zoom;
        if (key === lastKey) { if (++stableCount >= 5) return last; }
        else { lastKey = key; stableCount = 0; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return last;
}

// Kill ONLY this test's process tree. On Windows the playwright child is a
// cmd.exe wrapper whose kill() would orphan the real electron tree.
function killTree(child) {
    if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        child.kill('SIGKILL');
    }
}

// Product close path with the existing tests' precedent: stub the native
// confirm dialog (choice 1 = 不保存退出), then close the window via setTimeout
// so the evaluate settles before the app tears down. Never swallowed: a
// failure or timeout is a recorded failure and escalates to killTree.
async function closeProduct(app) {
    const closeEvent = app.waitForEvent('close', { timeout: CLOSE_TIMEOUT_MS });
    await app.evaluate(({ dialog, BrowserWindow }) => {
        dialog.showMessageBoxSync = () => 1;
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
    });
    await closeEvent;
}

await fs.mkdir(path.resolve('tmp'), { recursive: true });
const root = await fs.mkdtemp(path.resolve('tmp/dsk005-a-desktop-'));
const profile = path.join(root, 'profile');
await fs.mkdir(profile, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
let exitedPromise = null;
let pid = null;
let initial = null;
let finalState = null;
let workArea = null;
let scaleFactor = null;
let fullyWithinWorkArea = false;
let result = 'FAIL';
let finalExitCode = 1;
let childConfirmed = false;

try {
    app = await electron.launch({
        executablePath: createRequire(import.meta.url)('electron'),
        args: [path.resolve('.audit/desktop-app'), `--director-test-profile=${profile}`],
        env,
    });
    pid = app.process().pid;
    // Registered BEFORE any close attempt: kill() returning is not proof of exit.
    exitedPromise = new Promise(resolve => {
        app.process().once('exit', (code, signal) => resolve({ code, signal }));
    });

    const page = await app.firstWindow();
    await page.waitForSelector('.application-menu', { timeout: 60000 });

    initial = await readWindowState(app);
    if (initial.missing) throw new Error('no BrowserWindow after launch');

    const target = initial.displays.find(d => d.workArea.width >= TARGET_W && d.workArea.height >= TARGET_H);
    if (!target) {
        result = 'BLOCKED';
        console.error(`BLOCKED: no single display workArea is at least ${TARGET_W}x${TARGET_H}. Measured workAreas (no cross-display summing):`);
        for (const d of initial.displays) {
            console.error(`  display ${d.id}: workArea=${JSON.stringify(d.workArea)} bounds=${JSON.stringify(d.bounds)} scaleFactor=${d.scaleFactor}`);
        }
    } else {
        const wa = target.workArea;
        await app.evaluate(({ BrowserWindow }, b) => {
            BrowserWindow.getAllWindows()[0].setBounds(b);
        }, {
            x: wa.x + Math.floor((wa.width - TARGET_W) / 2),
            y: wa.y + Math.floor((wa.height - TARGET_H) / 2),
            width: TARGET_W,
            height: TARGET_H,
        });

        finalState = await waitForStableWindowState(app);
        if (finalState.missing) throw new Error('main BrowserWindow disappeared before re-measurement');
        const hosting = finalState.displays.find(d => d.id === finalState.hostingDisplayId);
        workArea = hosting ? hosting.workArea : null;
        scaleFactor = hosting ? hosting.scaleFactor : null;
        const b = finalState.bounds;
        const edges = workArea ? {
            left: b.x - workArea.x,
            top: b.y - workArea.y,
            right: workArea.x + workArea.width - (b.x + b.width),
            bottom: workArea.y + workArea.height - (b.y + b.height),
        } : null;
        fullyWithinWorkArea = !!edges && edges.left >= 0 && edges.top >= 0 && edges.right >= 0 && edges.bottom >= 0;

        if (finalState.hostingDisplayId !== target.id) {
            fail(`window settled on display ${finalState.hostingDisplayId}, expected the placement target display ${target.id}`);
        }
        if (b.width !== TARGET_W) fail(`width is ${b.width}, expected exactly ${TARGET_W}`);
        if (b.height !== TARGET_H) fail(`height is ${b.height}, expected exactly ${TARGET_H}`);
        if (finalState.zoom !== 1) fail(`zoomFactor is ${finalState.zoom}, expected exactly 1`);
        if (!finalState.visible) fail('window is not visible');
        if (finalState.minimized) fail('window is minimized');
        if (!edges) fail(`window's hosting display ${finalState.hostingDisplayId} not found in getAllDisplays`);
        else if (!fullyWithinWorkArea) {
            fail(`window not fully inside its hosting display's workArea ${JSON.stringify(workArea)}; edge margins px=${JSON.stringify(edges)} (negative = outside), bounds=${JSON.stringify(b)}`);
        }
    }
} catch (error) {
    fail(`launch/measure step failed: ${error instanceof Error ? (error.stack || error.message) : String(error)}`);
} finally {
    let productCloseOk = false;
    if (app) {
        try {
            await withTimeout(closeProduct(app), CLOSE_TIMEOUT_MS + 5000, 'product close path');
            productCloseOk = true;
        } catch (error) {
            fail(`product close path failed or timed out: ${error instanceof Error ? error.message : String(error)}`);
            // Kill only THIS test's process tree; kill returning is not exit —
            // the child 'exit' wait below is still mandatory.
            try { killTree(app.process()); } catch (killError) {
                fail(`killTree() after failed close threw: ${killError instanceof Error ? killError.message : String(killError)}`);
            }
        }
        if (exitedPromise) {
            try {
                const exit = await withTimeout(exitedPromise, EXIT_TIMEOUT_MS, 'electron child process exit');
                if (exit) { childConfirmed = true; console.error(`electron child exited: code=${exit.code} signal=${exit.signal}`); }
                else fail('electron child process exit was not confirmed');
            } catch (error) {
                fail(`electron child process did not exit: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (!productCloseOk && childConfirmed) fail('close failed or timed out; process tree only ended via taskkill');
    } else {
        fail('electron app never launched');
    }

    if (result === 'BLOCKED') {
        finalExitCode = 2;
    } else if (failures.length === 0 && !unhandledSeen && childConfirmed) {
        result = 'PASS';
        finalExitCode = 0;
    } else {
        result = 'FAIL';
        finalExitCode = 1;
    }
    for (const message of failures) console.error(`FAIL: ${message}`);
    if (unhandledSeen) console.error(`FAIL: unhandledRejection observed: ${unhandledDetail}`);

    console.log(JSON.stringify({
        initialBounds: initial && !initial.missing ? initial.bounds : null,
        finalBounds: finalState && !finalState.missing ? finalState.bounds : null,
        zoomFactor: finalState && !finalState.missing ? finalState.zoom : null,
        displayId: finalState && !finalState.missing ? finalState.hostingDisplayId : null,
        workArea,
        scaleFactor,
        fullyWithinWorkArea,
        pid,
        exitCode: finalExitCode,
        result,
    }));
    process.exitCode = finalExitCode;
}
