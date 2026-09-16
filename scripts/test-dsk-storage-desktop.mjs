// DSK-004 acceptance A2/A4/A6 (real product path): launches the ACTUAL prepared app in
// .audit/desktop-app with isolated profiles and a shared isolated storage directory, then drives
// window.directorDesktop.dsk() from the real renderer through the bundled storage.v1 contract.
// Covers: full upload/commit/status/download round-trip over chunked base64, session/lease
// behavior across TWO REAL Electron processes (busy rejection on save, hard kill -> TTL expiry
// takeover with a generation increment, release -> reacquire) and legacy IPC regression.
// Usage: node scripts/test-dsk-storage-desktop.mjs   (run after npm run desktop:prepare)
// The short lease TTL is only honored by the unpackaged test build via DIRECTOR_STORAGE_LEASE_TTL_MS.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import esbuild from 'esbuild';

const root = path.resolve('.');
const app = path.join(root, '.audit/desktop-app');
const require = createRequire(import.meta.url);

const fail = message => {
    console.error('DESKTOP-STORAGE-FAIL: ' + message);
    process.exitCode = 1;
};

for (const file of ['package.json', 'desktop/main.cjs', 'desktop/integration.cjs', 'dist/index.html']) {
    if (!fsSync.existsSync(path.join(app, file))) fail(`missing prepared file ${file} (run npm run desktop:prepare first)`);
}
const staged = fsSync.readFileSync(path.join(app, 'desktop/integration.cjs'), 'utf8');
for (const marker of ['director-dsk', 'storage.v1.session.bootstrap', 'project_leases', 'UNTRUSTED_SENDER']) {
    if (!staged.includes(marker)) fail(`staged integration.cjs lacks storage marker: ${marker}`);
}
if (process.exitCode) process.exit(process.exitCode);

// Build a small node-side helper bundle that fabricates a REAL valid SceneDocument via the
// production engine factory (demoProject + readSceneDocument), identical to the app's own output.
const helperFile = path.join(root, 'tmp', `dsk-storage-helper-${process.pid}.cjs`);
await esbuild.build({
    stdin: { contents: [
        "export { readSceneDocument } from './src/scenes/sequence-project.ts';",
        "export { demoProject } from './src/model.ts';",
        "export { canonicalJson } from './shared/storage/canonical.ts';",
    ].join('\n'), resolveDir: root, loader: 'ts' },
    outfile: helperFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
process.on('exit', () => { try { fsSync.rmSync(helperFile, { force: true }); } catch { /* best effort */ } });
const helper = require(helperFile);
const DOCUMENT_NAME = '桌面端到端';
const canonicalDocument = (() => {
    const document = helper.readSceneDocument(helper.demoProject());
    document.name = DOCUMENT_NAME;
    return document;
})();
const documentJson = JSON.stringify(canonicalDocument);
const documentBytes = new TextEncoder().encode(documentJson).length;

const LEASE_TTL_MS = 4000;
const storageDir = path.join(root, 'tmp', `dsk-004-storage-lib-${process.pid}`);
const profiles = [1, 2].map(index => path.join(root, 'tmp', `dsk-004-storage-profile-${process.pid}-${index}`));
for (const dir of [storageDir, ...profiles]) await fs.mkdir(dir, { recursive: true });

const executable = require('electron');
const children = [];
function launch(profile) {
    const child = spawn(executable, [app, `--director-test-profile=${profile}`, `--director-storage-dir=${storageDir}`, '--remote-debugging-port=0'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DIRECTOR_STORAGE_LEASE_TTL_MS: String(LEASE_TTL_MS) },
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stderrTail = () => stderr.slice(-400);
    return child;
}
const killTree = child => {
    if (child.killed || !child.pid) return;
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};
process.on('exit', () => { for (const child of children) killTree(child); });

async function terminate(child) {
    child.removeAllListeners('exit');
    if (!child.killed && child.pid) child.kill();
    await new Promise(resolve => {
        const timer = setTimeout(() => { killTree(child); resolve(); }, 5000).unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}

const cdpFetchJson = url => new Promise((resolve, reject) => {
    const request = http.get(url, { family: 4 }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('cdp fetch timeout')));
});

async function waitReady(child, profile) {
    let cdpPort = 0;
    for (let waited = 0; waited < 20000 && !cdpPort; waited += 300) {
        await new Promise(resolve => setTimeout(resolve, 300));
        try { cdpPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]) || 0; } catch { /* not ready */ }
    }
    if (!cdpPort) throw new Error(`DevToolsActivePort never appeared; electron exit=${child.exitCode}, stderr tail: ${child.stderrTail() || '(empty)'}`);
    let targets = [];
    for (let waited = 0; waited < 30000; waited += 500) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try { targets = await cdpFetchJson(`http://127.0.0.1:${cdpPort}/json/list`); } catch { continue; }
        if (targets.some(target => String(target.url).startsWith('director://app/'))) break;
    }
    if (!targets.some(target => String(target.url).startsWith('director://app/'))) {
        throw new Error(`director://app page never appeared over CDP; stderr tail: ${child.stderrTail() || '(empty)'}`);
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    let page = null;
    for (const context of browser.contexts()) {
        page = context.pages().find(candidate => candidate.url().startsWith('director://app/')) ?? page;
    }
    if (!page) throw new Error('could not attach to the director://app page');
    return { browser, page };
}

const expect = (condition, label) => { if (!condition) fail(label); return condition; };
const code = result => (result && result.ok === false && result.error) ? result.error.message : JSON.stringify(result);

// Renderer-side helpers (evaluated inside the real page; the dsk channel is the only bridge).
const pageCallHelper = `
window.__dskCall = async (action, data) => {
    try { return await window.directorDesktop.dsk(action, data); }
    catch (error) { return { ok: false, error: { code: 'RENDERER_EXCEPTION', message: String(error) } }; }
};
window.__dskUpload = async (sessionId, expectedRevision, documentJson, name) => {
    const bytes = new TextEncoder().encode(documentJson);
    const begin = await window.__dskCall('storage.v1.upload.begin', {
        sessionId, expectedRevision, declaredLength: bytes.length, ...(name ? { name } : {}),
    });
    if (!begin.ok) return { begin };
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        let binary = '';
        for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
        const chunk = await window.__dskCall('storage.v1.upload.chunk', { transferId, offset, data: btoa(binary) });
        if (!chunk.ok) return { chunk };
    }
    const commit = await window.__dskCall('storage.v1.upload.commit', { transferId });
    return { begin, chunks: Math.ceil(bytes.length / chunkSize), commit };
};
true;
`;

// Hard deadline so a stalled CDP/Electron cannot hang the runner (exit 0 only on success).
const deadline = setTimeout(() => {
    fail(`global deadline (300s) exceeded`);
    for (const child of children) killTree(child);
    process.exit(1);
}, 300000).unref();

try {
    // --- Phase 1: single real process — full managed snapshot round trip ---------------------
    const childA = launch(profiles[0]);
    const a = await waitReady(childA, profiles[0]);
    await a.page.evaluate(pageCallHelper);
    const phase1 = await a.page.evaluate(async documentJson => {
        const call = window.__dskCall;
        const out = { steps: [] };
        out.legacyProfilesReachable = await (async () => {
            try { const result = await window.directorDesktop.profiles(); return result !== null && typeof result === 'object' && typeof result.ok === 'boolean'; } catch { return false; }
        })();
        out.steps.push(['bootstrap-empty', await call('storage.v1.session.bootstrap', {})]);
        const created = await call('project.create', { name: '桌面端到端' });
        out.steps.push(['create', created]);
        if (!created.ok) return out;
        const sessionId = created.data.sessionId, projectId = created.data.projectId;
        const upload = await window.__dskUpload(sessionId, 0, documentJson, '桌面端到端');
        out.steps.push(['upload', upload]);
        if (!upload.commit || !upload.commit.ok) return out;
        const status = await call('project.status', { projectId });
        const read = await call('storage.v1.snapshot.read', { sessionId });
        let downloaded = null;
        if (read.ok) {
            const parts = []; let final = false;
            while (!final) {
                const chunk = await call('storage.v1.snapshot.download.chunk', { transferId: read.data.transferId });
                if (!chunk.ok) break;
                parts.push(chunk.data.data);
                final = chunk.data.final;
            }
            downloaded = parts.map(part => Array.from(atob(part)).map(character => character.charCodeAt(0))).flat();
        }
        const activate = await call('storage.v1.session.activate', { sessionId });
        const bootAfter = await call('storage.v1.session.bootstrap', {});
        const listAfter = await call('storage.v1.project.list', { limit: 10 });
        const unknownSession = await call('storage.v1.project.close', { sessionId: 'sess-nonexistent00' });
        return {
            steps: out.steps, legacyProfilesReachable: out.legacyProfilesReachable,
            projectId, status, read, downloaded, activate, bootAfter, listAfter, unknownSession,
        };
    }, documentJson).catch(error => { throw new Error('phase 1 evaluate failed: ' + error.message); });

    const stepValue = label => phase1.steps.find(step => step[0] === label)?.[1];
    const openedSessionA = stepValue('create').data.sessionId;
    expect(phase1.legacyProfilesReachable, 'legacy director-host channel no longer responds');
    expect(stepValue('bootstrap-empty').ok && stepValue('bootstrap-empty').data.mode === null, `fresh bootstrap should report no choice, got ${code(stepValue('bootstrap-empty'))}`);
    expect(!!stepValue('create').ok, `project.create failed: ${code(stepValue('create'))}`);
    const upload = stepValue('upload');
    expect(upload.commit && upload.commit.ok, `upload/commit failed: begin=${code(upload.begin)} chunk=${code(upload.chunk)} commit=${code(upload.commit)}`);
    expect(upload.commit.ok && upload.commit.data.revision === 1, 'first commit must produce revision 1');
    expect(upload.begin.ok && upload.begin.data.declaredLength === documentBytes, 'declared upload length must match the real document bytes');
    expect(phase1.status.ok && phase1.status.data.revision === 1, 'project.status must report the committed revision');
    expect(phase1.status.ok && phase1.status.data.lease.owned === true && phase1.status.data.lease.busy === false, 'own lease must report owned and not busy');
    expect(phase1.status.ok && phase1.status.data.integrity.missing === 0 && phase1.status.data.integrity.corrupt === 0 && phase1.status.data.integrity.orphans === 0, 'integrity must be clean after commit');
    expect(phase1.read.ok, `snapshot.read failed: ${code(phase1.read)}`);
    expect(phase1.downloaded && new TextDecoder().decode(new Uint8Array(phase1.downloaded)) === helper.canonicalJson(canonicalDocument), 'downloaded snapshot must be the canonical snapshot bytes');
    expect(phase1.activate.ok, `session.activate failed: ${code(phase1.activate)}`);
    expect(phase1.bootAfter.ok && phase1.bootAfter.data.mode === 'managed' && phase1.bootAfter.data.projectId === phase1.projectId, 'activate must persist the managed choice');
    expect(phase1.listAfter.ok && phase1.listAfter.data.projects.length === 1, 'project.list must contain the created project');
    expect(code(phase1.unknownSession) === 'storage.v1/unknown-session', `cross-session close must be refused, got ${code(phase1.unknownSession)}`);
    console.log(`PHASE1-OK: create/upload/commit (revision 1, ${documentBytes} bytes)/status/download/activate over the real dsk channel`);

    // --- Phase 1.5: a real >256KiB project crosses the generic IPC limit via chunking --------
    const largeDocument = (() => {
        const document = JSON.parse(documentJson);
        const padding = 'A'.repeat(400 * 1024); // valid data:image/png;base64 payload content
        document.scenes[0].state.references = [
            { id: 'reference-large', name: '大参考图', data: 'data:image/png;base64,' + padding },
        ];
        return document;
    })();
    const largeJson = JSON.stringify(largeDocument);
    const largeBytes = new TextEncoder().encode(largeJson).length;
    if (!(expect(largeBytes > 256 * 1024, `large fixture must exceed the 256KiB generic IPC limit, got ${largeBytes}`))) { }
    const largeUpload = await a.page.evaluate(async payload => {
        const uploaded = await window.__dskUpload(payload.sessionId, 1, payload.documentJson);
        if (!uploaded.commit || !uploaded.commit.ok) return { uploaded };
        const read = await window.__dskCall('storage.v1.snapshot.read', { sessionId: payload.sessionId });
        const parts = []; let final = false;
        while (read.ok && !final) {
            const chunk = await window.__dskCall('storage.v1.snapshot.download.chunk', { transferId: read.data.transferId });
            if (!chunk.ok) break;
            parts.push(chunk.data.data);
            final = chunk.data.final;
        }
        const bytes = parts.map(part => Array.from(atob(part)).map(character => character.charCodeAt(0))).flat();
        return { uploaded, read, digestBytes: bytes };
    }, { sessionId: openedSessionA, documentJson: largeJson }).catch(error => ({ error: String(error) }));
    if (!(expect(!largeUpload.error, `large upload failed: ${largeUpload.error}`))) { }
    if (!(expect(largeUpload.uploaded && largeUpload.uploaded.begin && largeUpload.uploaded.begin.ok, `large upload.begin failed: ${JSON.stringify(largeUpload.uploaded && largeUpload.uploaded.begin)}`))) { }
    if (!(expect(largeUpload.uploaded && largeUpload.uploaded.chunks >= Math.ceil(largeBytes / 49152), 'large upload must run multiple 48KiB chunk iterations'))) { }
    if (!(expect(largeUpload.uploaded && largeUpload.uploaded.commit.ok, `large commit failed: ${JSON.stringify(largeUpload.uploaded && largeUpload.uploaded.commit)}`))) { }
    const largeDigest = crypto.createHash('sha256').update(Buffer.from(helper.canonicalJson(largeDocument), 'utf8')).digest('hex');
    if (!(expect(largeUpload.uploaded.commit.data.snapshot.digest === largeDigest, 'node-side and main-process canonical digests must be identical'))) { }
    if (!(expect(new TextDecoder().decode(new Uint8Array(largeUpload.digestBytes)) === helper.canonicalJson(largeDocument), 'large download must return identical canonical bytes'))) { }
    console.log(`PHASE1.5-OK: ${(largeBytes / 1024).toFixed(0)}KiB project crossed the generic IPC limit via ${largeUpload.uploaded.chunks} chunks; canonical digest matches the node side (${largeDigest.slice(0, 12)}…)`);
    // Process A stays ALIVE with its renewing lease (generation 1): phases 2-5 run a genuine
    // two-live-process competition instead of a staged takeover against a corpse.

    // --- Phase 2: BOTH processes alive — B sees the busy lease and cannot save ---------------
    const childB = launch(profiles[1]);
    const b = await waitReady(childB, profiles[1]);
    await b.page.evaluate(pageCallHelper);
    const openedB = await b.page.evaluate(async payload => {
        const opened = await window.__dskCall('project.open', { projectId: payload.projectId });
        const attemptedSave = opened.ok
            ? await window.__dskUpload(opened.data.sessionId, opened.data.revision, payload.documentJson)
            : null;
        return { opened, attemptedSave };
    }, { projectId: phase1.projectId, documentJson }).catch(error => { throw new Error('phase 2 evaluate failed: ' + error.message); });
    // Keep both CDP connections open: phases 3-5 drive the same real pages.
    expect(openedB.opened.ok, `process B failed to open the project: ${code(openedB.opened)}`);
    expect(openedB.opened.data.leaseOwned === false && openedB.opened.data.leaseBusy === true, 'process B must see the busy lease without stealing it while A is alive');
    expect(openedB.attemptedSave && openedB.attemptedSave.begin && !openedB.attemptedSave.begin.ok
        && openedB.attemptedSave.begin.error.message === 'storage.v1/lease-busy', `busy process save must fail with lease-busy, got ${JSON.stringify(openedB.attemptedSave?.begin)}`);
    const sessionB = openedB.opened.data.sessionId;
    console.log('PHASE2-OK: with A and B both live, B sees the busy lease and its save is refused (lease-busy)');

    // --- Phase 3: A releases explicitly; B takes over with generation 2 and commits ----------
    const releaseA = await a.page.evaluate(async sessionId => {
        return await window.__dskCall('storage.v1.project.close', { sessionId });
    }, openedSessionA);
    expect(releaseA.ok && releaseA.data.closed, `A failed to release its lease: ${JSON.stringify(releaseA)}`);
    const takeover = await b.page.evaluate(async payload => {
        const uploaded = await window.__dskUpload(payload.sessionId, payload.revision, payload.documentJson);
        return { uploaded };
    }, { sessionId: sessionB, revision: largeUpload.uploaded.commit.data.revision, documentJson });
    expect(takeover.uploaded && takeover.uploaded.commit && takeover.uploaded.commit.ok,
        `B release-takeover save failed: begin=${JSON.stringify(takeover.begin)} chunk=${JSON.stringify(takeover.uploaded && takeover.uploaded.chunk)} commit=${JSON.stringify(takeover.uploaded && takeover.uploaded.commit)}`);
    const statusAfterRelease = await b.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    expect(statusAfterRelease.ok && statusAfterRelease.data.lease.generation === 2,
        `release takeover must increment generation to 2, got ${JSON.stringify(statusAfterRelease.data && statusAfterRelease.data.lease)}`);
    console.log('PHASE3-OK: A released while alive; B took over with generation 2 and committed');

    // --- Phase 4: the OLD writer A is refused while B owns the lease -------------------------
    const reopenedA = await a.page.evaluate(async payload => {
        const opened = await window.__dskCall('project.open', { projectId: payload.projectId });
        const attemptedSave = opened.ok
            ? await window.__dskUpload(opened.data.sessionId, opened.data.revision, payload.documentJson)
            : null;
        return { opened, attemptedSave };
    }, { projectId: phase1.projectId, documentJson }).catch(error => ({ error: String(error) }));
    expect(reopenedA.opened && reopenedA.opened.ok && reopenedA.opened.data.leaseBusy === true,
        `A must see the project busy once B owns the lease: ${JSON.stringify(reopenedA.opened)}`);
    expect(reopenedA.attemptedSave && reopenedA.attemptedSave.begin && !reopenedA.attemptedSave.begin.ok
        && reopenedA.attemptedSave.begin.error.message === 'storage.v1/lease-busy',
        `the old writer must be refused while B owns: ${JSON.stringify(reopenedA.attemptedSave?.begin)}`);
    console.log('PHASE4-OK: the old writer A is refused (lease-busy) while B owns the lease');

    // --- Phase 5: B releases; A acquires generation 3; A is hard-killed; B takes the expired lease as generation 4 ---
    const releaseB = await b.page.evaluate(async sessionId => {
        return await window.__dskCall('storage.v1.project.close', { sessionId });
    }, sessionB);
    expect(releaseB.ok && releaseB.data.closed, `B failed to release its lease: ${JSON.stringify(releaseB)}`);
    const aTakeover = await a.page.evaluate(async payload => {
        const opened = await window.__dskCall('project.open', { projectId: payload.projectId });
        if (!opened.ok || !opened.data.leaseOwned) return { opened };
        const begin = await window.__dskCall('storage.v1.upload.begin', { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision, declaredLength: 16 });
        return { opened, begin, sessionId: opened.data.sessionId };
    }, { projectId: phase1.projectId });
    expect(aTakeover.opened && aTakeover.opened.ok && aTakeover.opened.data.leaseOwned === true,
        `A must reacquire the released lease: ${JSON.stringify(aTakeover.opened)}`);
    expect(aTakeover.begin && aTakeover.begin.ok, `A begin after reacquire failed: ${JSON.stringify(aTakeover.begin)}`);
    const generationAfterA = (await a.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId)).data.lease.generation;
    expect(generationAfterA === 3, `A takeover must hold generation 3, got ${generationAfterA}`);
    await a.browser.close();
    await terminate(childA); // A dies holding generation 3; its lease must expire before B may write
    const expiryStart = Date.now();
    let expiryTakeover = null;
    while (Date.now() - expiryStart < 20000) {
        await new Promise(resolve => setTimeout(resolve, 800));
        const attempt = await b.page.evaluate(async payload => {
            const opened = await window.__dskCall('project.open', { projectId: payload.projectId });
            if (!opened.ok) return { opened };
            const status = await window.__dskCall('project.status', { projectId: payload.projectId });
            return await window.__dskUpload(opened.data.sessionId, status.ok ? status.data.revision : opened.data.revision, payload.documentJson);
        }, { projectId: phase1.projectId, documentJson }).catch(error => ({ commit: null, error: String(error) }));
        if (attempt.commit && attempt.commit.ok) { expiryTakeover = attempt; break; }
        if (attempt.error) { fail(`expiry takeover loop failed: ${attempt.error}`); break; }
    }
    expect(!!expiryTakeover, 'process B could not take over the expired lease after A died');
    if (expiryTakeover) {
        const status = await b.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
        expect(status.ok && status.data.lease.generation === 4, `expiry takeover must reach generation 4, got ${JSON.stringify(status.data && status.data.lease)}`);
        console.log(`PHASE5-OK: after A died holding generation 3, the ${LEASE_TTL_MS}ms TTL expired and B took over with generation 4, committing revision ${status.data.revision}`);
    }
    await b.browser.close();
    await terminate(childB);
    await fs.rm(storageDir, { recursive: true, force: true });
    for (const profile of profiles) await fs.rm(profile, { recursive: true, force: true });

    if (!process.exitCode) console.log('DESKTOP-STORAGE-OK: managed snapshots, leases (two real processes: busy / expiry-takeover / generation / release) and bounded transfers verified on the prepared app.');
} catch (error) {
    fail(error && error.message ? error.message + ' || STACK: ' + String(error.stack).slice(0, 800) : String(error));
} finally {
    for (const child of children) await terminate(child).catch(() => { });
}
process.exit(process.exitCode || 0);
