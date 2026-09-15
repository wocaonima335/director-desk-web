// DSK-003 acceptance A2/A5: real desktop loop-back verification for the dsk.v1 IPC channel.
// Launches the ACTUAL prepared app in .audit/desktop-app with an isolated profile and CDP,
// then exercises window.directorDesktop.dsk() from the real renderer through the bundled
// shared contracts. Static assertions alone are not treated as evidence.
// Usage: node scripts/test-dsk-contracts-desktop.mjs   (run after npm run desktop:prepare)
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = path.resolve('.');
const app = path.join(root, '.audit/desktop-app');
const require = createRequire(import.meta.url);

const fail = message => {
    console.error('DESKTOP-DSK-FAIL: ' + message);
    process.exitCode = 1;
};

// Precondition: the staged payload must already contain the bundled shared contract.
for (const file of ['package.json', 'desktop/main.cjs', 'desktop/integration.cjs', 'dist/index.html']) {
    if (!fsSync.existsSync(path.join(app, file))) fail(`missing prepared file ${file} (run npm run desktop:prepare first)`);
}
if (process.exitCode) process.exit(process.exitCode);
const staged = fsSync.readFileSync(path.join(app, 'desktop/integration.cjs'), 'utf8');
for (const marker of ['director-dsk', 'dsk.v1', 'NOT_IMPLEMENTED', 'UNTRUSTED_SENDER']) {
    if (!staged.includes(marker)) fail(`staged integration.cjs lacks dsk contract marker: ${marker}`);
}
if (process.exitCode) process.exit(process.exitCode);

const profile = path.join(root, 'tmp', `dsk-003-desktop-profile-${process.pid}`);
await fs.mkdir(profile, { recursive: true });
const executable = require('electron');
const child = spawn(executable, [app, `--director-test-profile=${profile}`, '--remote-debugging-port=0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const terminate = async () => {
    child.removeAllListeners('exit');
    if (!child.killed) child.kill();
    await new Promise(resolve => {
        const timer = setTimeout(() => {
            if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            resolve();
        }, 5000).unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fs.rm(profile, { recursive: true, force: true });
};
process.on('exit', () => { if (!child.killed && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); });

// The app quits itself when the verification page is closed by terminate(); keep a hard deadline.
const deadline = setTimeout(async () => {
    fail(`timed out after 90s${stderr ? '; electron stderr tail: ' + stderr.slice(-400) : ''}`);
    await terminate();
    process.exit(process.exitCode || 1);
}, 90000).unref();

try {
    // Chromium picks a free port itself and records it in <profile>/DevToolsActivePort; polling
    // /json/list over plain IPv4 http avoids undici autoSelectFamily issues on Windows.
    const cdpFetchJson = url => new Promise((resolve, reject) => {
        const request = http.get(url, { family: 4 }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
        });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('cdp fetch timeout')));
    });
    let cdpPort = 0;
    for (let waited = 0; waited < 15000 && !cdpPort; waited += 300) {
        await new Promise(resolve => setTimeout(resolve, 300));
        try { cdpPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]) || 0; } catch { /* not ready yet */ }
    }
    if (!cdpPort) throw new Error(`DevToolsActivePort never appeared; electron exit=${child.exitCode}, stderr tail: ${stderr.slice(-400) || '(empty)'}`);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    let targets = [];
    let polls = 0, fetchErrors = '';
    for (let waited = 0; waited < 30000; waited += 500) {
        await new Promise(resolve => setTimeout(resolve, 500));
        polls += 1;
        try { targets = await cdpFetchJson(cdpUrl + '/json/list'); } catch (error) {
            fetchErrors += (error.cause && error.cause.code ? error.cause.code : error.message) + ' ';
            continue;
        }
        if (targets.some(target => String(target.url).startsWith('director://app/'))) break;
    }
    if (!targets.some(target => String(target.url).startsWith('director://app/')))
        throw new Error(`director://app page never appeared over CDP after ${polls} polls (fetch errors: ${fetchErrors.trim() || 'none'})` +
            `; electron exit=${child.exitCode}, stderr tail: ${stderr.slice(-400) || '(empty)'}`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const page = await (async () => {
        for (const context of browser.contexts()) {
            const found = context.pages().find(candidate => candidate.url().startsWith('director://app/'));
            if (found) return found;
        }
        for (const context of browser.contexts()) {
            const found = await new Promise(resolve => {
                const timer = setTimeout(() => { context.off('page', onPage); resolve(null); }, 10000).unref();
                const onPage = candidate => { if (candidate.url().startsWith('director://app/')) { clearTimeout(timer); resolve(candidate); } };
                context.on('page', onPage);
            });
            if (found) return found;
        }
        return null;
    })();
    if (!page) throw new Error('could not attach to the director://app page');

    const spec = {
        version: 'dsk.v1', specId: 'spec-loopback-01', title: '回环验证', premise: '天台交接的确定性回环验证用例。',
        mode: 'single-shot', aspect: '9:16', fps: 24,
        characters: [{ roleId: 'lin-xia', name: '林夏', look: '齐肩短发', wardrobe: '深灰风衣' }],
        environment: { location: '城市天台', summary: '夜晚天台', timeOfDay: 'night' },
        targetDurationSec: 8,
    };
    const results = await page.evaluate(async storySpec => {
        const desktop = window.directorDesktop;
        const call = async (action, data) => {
            try { return await desktop.dsk(action, data); } catch (error) { return { ok: false, error: { code: 'RENDERER_EXCEPTION', message: String(error) } }; }
        };
        return {
            hasDsk: typeof desktop?.dsk === 'function',
            legacyApi: {
                profiles: typeof desktop?.profiles, run: typeof desktop?.run, onEvent: typeof desktop?.onEvent,
                files: typeof desktop?.files, skills: typeof desktop?.skills, onUpdate: typeof desktop?.onUpdate,
            },
            legacyProfilesReachable: await (async () => {
                try { const result = await desktop.profiles(); return result !== null && typeof result === 'object' && typeof result.ok === 'boolean'; } catch { return false; }
            })(),
            modelStatus: await call('model.status', {}),
            stateGet: await call('state.get', { workflowId: 'wf-loopback-01' }),
            planValid: await call('plan.submit-spec', { spec: storySpec }),
            planInvalid: await call('plan.submit-spec', { spec: { ...storySpec, premise: '' } }),
            unknownAction: await call('fs.read', {}),
        };
    }, spec);
    await browser.close();
    clearTimeout(deadline);
    await terminate();

    const expect = (condition, label) => { if (!condition) fail(label); };
    const code = result => (result && result.ok === false && result.error) ? result.error.code : JSON.stringify(result);
    expect(results.hasDsk, 'preload did not expose directorDesktop.dsk');
    for (const [name, kind] of Object.entries(results.legacyApi)) expect(kind === 'function', `legacy API ${name} missing (old IPC surface must stay intact)`);
    expect(results.legacyProfilesReachable, 'legacy director-host channel no longer responds');
    expect(code(results.modelStatus) === 'NOT_IMPLEMENTED', `model.status expected NOT_IMPLEMENTED, got ${code(results.modelStatus)}`);
    expect(code(results.stateGet) === 'NOT_IMPLEMENTED', `state.get expected NOT_IMPLEMENTED, got ${code(results.stateGet)}`);
    expect(code(results.planValid) === 'NOT_IMPLEMENTED', `valid plan.submit-spec should pass schema then hit NOT_IMPLEMENTED, got ${code(results.planValid)}`);
    expect(code(results.planInvalid) === 'INVALID_PAYLOAD', `invalid spec expected INVALID_PAYLOAD, got ${code(results.planInvalid)}`);
    expect(code(results.unknownAction) === 'INVALID_ACTION', `unknown action expected INVALID_ACTION, got ${code(results.unknownAction)}`);
    if (!process.exitCode) console.log('DESKTOP-DSK-OK: prepared app loaded the bundled dsk.v1 contract; ' +
        'dsk channel validated payloads (NOT_IMPLEMENTED for legal actions, INVALID_PAYLOAD/INVALID_ACTION for bad ones) and legacy IPC stayed intact.');
} catch (error) {
    fail(error && error.message ? error.message : String(error));
    await terminate();
} finally {
    clearTimeout(deadline);
}
process.exit(process.exitCode || 0);
