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
const profiles = [1, 2, 3, 4, 5].map(index => path.join(root, 'tmp', `dsk-004-storage-profile-${process.pid}-${index}`));
for (const dir of [storageDir, ...profiles]) await fs.mkdir(dir, { recursive: true });

const executable = require('electron');
const children = [];
function launch(profile, storageOverride) {
    const child = spawn(executable, [app, `--director-test-profile=${profile}`, `--director-storage-dir=${storageOverride ?? storageDir}`, '--remote-debugging-port=0'], {
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
    // Already-exited children never emit 'exit' again; return instead of awaiting forever
    // (an unref'd fallback timer cannot keep the event loop alive to resolve).
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.killed && child.pid) child.kill();
    await new Promise(resolve => {
        const timer = setTimeout(() => { killTree(child); resolve(); }, 5000);
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
    fail(`global deadline (600s) exceeded`);
    for (const child of children) killTree(child);
    process.exit(1);
}, 600000).unref();

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

    // --- Phase 6: REAL renderer UI loop (R4/R5/R6/R11) --------------------------------------
    // Drives the actual DOM of the prepared app: startup auto-load of the persisted managed
    // choice, the new/import dirty confirmation (cancel AND accept paths), a real .director
    // import that must leave the managed session first, unmanaged import undo semantics, a
    // managed reopen that starts a fresh undo history (no cross-project leak), nextCursor
    // pagination, the project.status panel and an explicit UI leave. Backup/restore keep their
    // NATIVE directory pickers, which CDP cannot drive — recorded as the manual boundary.
    // Let process B's lease expire so profile C's startup open acquires it cleanly.
    await new Promise(resolve => setTimeout(resolve, LEASE_TTL_MS + 1500));
    const childC = launch(profiles[2]);
    const c = await waitReady(childC, profiles[2]);
    await c.page.evaluate(pageCallHelper);
    // R6 startup: the persisted managed choice (activated in phase 1) must auto-load through the
    // busy-guarded startup path and land confirmed with a clean save state.
    await c.page.waitForFunction(
        () => document.querySelector('#save-status')?.textContent?.startsWith('受管项目：'),
        undefined, { timeout: 30000 });
    const projectATitle = await c.page.title();
    const statusAtUiStart = await c.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    if (!(expect(statusAtUiStart.ok, `phase6 initial status failed: ${code(statusAtUiStart)}`))) { }
    const revisionAtUiStart = statusAtUiStart.data.revision;
    console.log(`PHASE6.0-OK: startup auto-loaded managed project A (revision ${revisionAtUiStart}) through the real UI`);

    // --- Phase 6MAX: F05 critical evidence on the real desktop app ---------------------------
    // A LEGAL full-budget project (exactly 67108864 canonical bytes) saves, commits, downloads
    // byte-identical and re-opens (fresh snapshot.read); 67108865 bytes are refused by contract.
    const maxDocument = (() => {
        // The document scanner caps single strings at 32MiB, so the budget is composed of many
        // legal reference payloads (220 segments) instead of one giant string.
        const segments = 220;
        const reference = index => ({ id: `reference-max-${index}`, name: `满额${index}`, data: 'data:image/png;base64,' + 'A'.repeat(64) });
        const padded = JSON.parse(documentJson);
        padded.scenes[0].state.references = Array.from({ length: segments }, (_, index) => reference(index));
        const fixedBytes = Buffer.byteLength(helper.canonicalJson(padded), 'utf8'); // measured WITH 64 A's per segment
        const padding = Math.floor((67108864 - fixedBytes) / segments) + 64; // the 64 A's are replaced, not added
        for (const entry of padded.scenes[0].state.references) entry.data = 'data:image/png;base64,' + 'A'.repeat(padding);
        const remainder = 67108864 - (Buffer.byteLength(helper.canonicalJson(padded), 'utf8'));
        padded.scenes[0].state.references[0].data = 'data:image/png;base64,' + 'A'.repeat(padding + remainder);
        const canonical = helper.canonicalJson(padded);
        const bytes = Buffer.byteLength(canonical, 'utf8');
        if (bytes !== 67108864) throw new Error(`64MiB fixture construction failed: ${bytes}`);
        return { json: canonical, bytes, digest: crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex') };
    })();
    const maxDoc = await c.page.evaluate(async payload => {
        const call = window.__dskCall;
        const created = await call('project.create', { name: '满额工程' });
        if (!created.ok) return { stage: 'create', reply: created };
        const sessionId = created.data.sessionId;
        // One byte beyond the budget is refused by the frozen payload contract.
        const overOne = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: payload.bytes + 1 });
        // The full 64MiB document uploads through the in-page chunk loop (1370 chunks).
        const uploaded = await window.__dskUpload(sessionId, 0, payload.json, '满额工程');
        if (!uploaded.commit || !uploaded.commit.ok) return { stage: 'upload', reply: uploaded, overOne };
        // Re-open: a fresh snapshot.read + full download must be byte-identical.
        const read = await call('storage.v1.snapshot.read', { sessionId });
        if (!read.ok) return { stage: 'read', reply: read, overOne };
        const parts = []; let final = false;
        while (!final) {
            const chunk = await call('storage.v1.snapshot.download.chunk', { transferId: read.data.transferId });
            if (!chunk.ok) return { stage: 'chunk', reply: chunk, overOne };
            parts.push(chunk.data.data);
            final = chunk.data.final;
        }
        // Decode the base64 chunks back into the UTF-8 document string (no Buffer in the page).
        const decoder = new TextDecoder('utf8');
        let downloaded = '';
        for (const part of parts) {
            const binary = atob(part);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            downloaded += decoder.decode(bytes);
        }
        return {
            overOne, uploaded, read,
            declaredMatches: uploaded.begin.data.declaredLength === payload.bytes,
            downloadedEquals: downloaded === payload.json,
            downloadedLength: downloaded.length,
            digest: uploaded.commit.data.snapshot.digest,
        };
    }, { json: maxDocument.json, bytes: maxDocument.bytes }).catch(error => ({ error: String(error) }));
    if (!(expect(!maxDoc.error, `64MiB phase evaluate failed: ${maxDoc.error}`))) { }
    expect(maxDoc.overOne && !maxDoc.overOne.ok, `67108865 bytes must be refused: ${JSON.stringify(maxDoc.overOne)}`);
    expect(maxDoc.uploaded && maxDoc.uploaded.commit && maxDoc.uploaded.commit.ok,
        `the full 64MiB upload failed: ${JSON.stringify(maxDoc.uploaded && (maxDoc.uploaded.begin || maxDoc.uploaded.chunk || maxDoc.uploaded.commit))}`);
    expect(maxDoc.declaredMatches, 'the declared length must be exactly 67108864');
    expect(maxDoc.digest === maxDocument.digest, 'the committed digest must match the node-side canonical bytes');
    expect(maxDoc.downloadedEquals, `the reopened download must be byte-identical (${maxDoc.downloadedLength} bytes)`);
    console.log(`PHASE6MAX-OK: legal 67108864-byte project saved/committed (digest ${maxDocument.digest.slice(0, 12)}…)/downloaded byte-identical/re-read; 67108865 refused`);


    // 6.1 R4 cancel: dirty editor + 新建 → the discard confirmation appears; cancelling keeps A.
    await c.page.click('[data-act="add-camera"]');
    await c.page.waitForFunction(
        () => document.querySelector('#save-status')?.textContent?.includes('未保存'),
        undefined, { timeout: 10000 });
    await c.page.click('[data-menu="file"]');
    await c.page.click('#application-menu-file [data-act="scene-templates"]');
    await c.page.waitForSelector('[data-act="confirm-new"]', { timeout: 10000 });
    await c.page.click('[data-act="confirm-new"]');
    await c.page.waitForSelector('#managed-switch-confirm', { timeout: 10000 });
    await c.page.click('#managed-switch-cancel');
    await c.page.waitForSelector('#managed-switch-confirm', { state: 'detached', timeout: 10000 });
    expect((await c.page.title()) === projectATitle, 'cancelling the dirty confirm must keep project A loaded');
    expect((await c.page.evaluate(() => document.querySelector('#save-status')?.textContent))?.includes('未保存'),
        'cancelling the dirty confirm must keep the unsaved marker');
    const statusAfterCancel = await c.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    expect(statusAfterCancel.ok && statusAfterCancel.data.revision === revisionAtUiStart,
        `a cancelled 新建 must not write into project A: ${JSON.stringify(statusAfterCancel.data && statusAfterCancel.data.revision)}`);
    console.log('PHASE6.1-OK: managed dirty confirm cancel kept the document identity, dirty state and project A untouched');

    // 6.2 R4 accept: a real .director import must leave the managed session before switching.
    // The file is set first; the parser/verifier run while A is untouched, and only then does the
    // discard confirmation appear (A is still dirty from 6.1).
    const importDocument = helper.readSceneDocument(helper.demoProject());
    importDocument.name = '导入R4工程';
    const importPath = path.join(root, 'tmp', `dsk-004-import-${process.pid}.director`);
    await fs.writeFile(importPath, JSON.stringify(importDocument), 'utf8');
    await c.page.setInputFiles('#project-file', importPath);
    await c.page.waitForSelector('#managed-switch-confirm', { timeout: 20000 });
    await c.page.click('#managed-switch-accept');
    // The leave itself updates save-status, but applyDocument immediately overwrites it with the
    // recovery/save flow text — the loaded document title plus the persisted bootstrap mode are
    // the reliable leave evidence here.
    await c.page.waitForFunction(
        () => document.title.includes('导入R4工程'),
        undefined, { timeout: 20000 });
    expect((await c.page.title()).includes('导入R4工程'), 'the imported document must replace the editor content after leave');
    const bootAfterImport = await c.page.evaluate(() => window.__dskCall('storage.v1.session.bootstrap', {}));
    expect(bootAfterImport.ok && bootAfterImport.data.mode === 'unmanaged', `import must persist the unmanaged choice, got ${JSON.stringify(bootAfterImport.data)}`);
    const statusAfterImport = await c.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    expect(statusAfterImport.ok && statusAfterImport.data.revision === revisionAtUiStart,
        `imported content must never write into the managed project: ${JSON.stringify(statusAfterImport.data && statusAfterImport.data.revision)}`);
    console.log('PHASE6.2-OK: real .director import left the managed session (confirm accept) and wrote nothing into project A');

    // 6.3 R5 unmanaged semantics: a plain new-project/import keeps the undo path across documents.
    await c.page.click('[data-menu="file"]');
    await c.page.click('#application-menu-file [data-act="scene-templates"]');
    await c.page.waitForSelector('[data-act="confirm-new"]', { timeout: 10000 });
    await c.page.click('[data-act="confirm-new"]');
    await c.page.waitForFunction(
        title => !document.title.includes(title),
        '导入R4工程', { timeout: 15000 });
    const templateTitle = await c.page.title();
    await c.page.keyboard.press('Control+z');
    await c.page.waitForFunction(
        title => document.title.includes(title),
        '导入R4工程', { timeout: 15000 });
    console.log('PHASE6.3-OK: unmanaged new/import keeps the cross-document undo semantics (undo returned the imported project)');
    await c.page.keyboard.press('Control+Shift+z'); // forward again before the managed reopen

    // 6.4 F10 cancel path: opening A while the template doc is dirty asks for confirmation and
    // cancelling has ZERO side effects (no candidate, no identity change, document untouched).
    // The library entry lives inside the file menu popover (mountApplicationMenu moves it there).
    await c.page.click('[data-menu="file"]');
    await c.page.click('#project-library-open');
    await c.page.waitForSelector('#project-library', { timeout: 10000 });
    await c.page.click(`[data-library-open="${phase1.projectId}"]`);
    await c.page.waitForSelector('#managed-switch-confirm', { timeout: 10000 });
    await c.page.click('#managed-switch-cancel');
    await c.page.waitForSelector('#managed-switch-confirm', { state: 'detached', timeout: 10000 });
    expect((await c.page.title()) === templateTitle, 'cancelling the open confirmation must keep the current document');
    const bootAfterCancel = await c.page.evaluate(() => window.__dskCall('storage.v1.session.bootstrap', {}));
    expect(bootAfterCancel.ok && bootAfterCancel.data.mode === 'unmanaged',
        `cancelling must not touch the persisted choice, got ${JSON.stringify(bootAfterCancel.data)}`);

    // 6.4b F08/R5 accept path: the confirmation REAPPEARING proves the dirty state survived the
    // cancel (F10 zero side effects); the managed switch then commits only after activate, and
    // the fresh history forbids undo from dragging the previous document into project A.
    await c.page.click(`[data-library-open="${phase1.projectId}"]`);
    await c.page.waitForSelector('#managed-switch-confirm', { timeout: 10000 });
    await c.page.click('#managed-switch-accept');
    await c.page.waitForFunction(
        () => document.querySelector('#save-status')?.textContent?.startsWith('受管项目：'),
        undefined, { timeout: 30000 });
    expect((await c.page.title()) === projectATitle, 'reopening project A must restore its document');
    // openProject finishes while ctx.busy is still held, so its closeModal is refused by the
    // modal pages guard and the library modal stays open; close it for real before the undo key.
    await c.page.click('.modal-footer [data-act="close-modal"]');
    await c.page.waitForSelector('#project-library', { state: 'detached', timeout: 10000 });
    const titleBeforeUndo = await c.page.title();
    await c.page.keyboard.press('Control+z');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await c.page.title()) === titleBeforeUndo,
        'undo after a managed switch must not resurrect the previous project (fresh history)');
    const statusAfterReopen = await c.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    expect(statusAfterReopen.ok && statusAfterReopen.data.revision === revisionAtUiStart,
        `reopening must not modify project A: ${JSON.stringify(statusAfterReopen.data && statusAfterReopen.data.revision)}`);
    console.log('PHASE6.4-OK: managed reopen via the library UI reloaded A with a fresh undo history; the F10 cancel path left zero side effects');

    // 6.4c F09 same-project reopen REUSES the live session: the lease generation must not move
    // (a close+reopen churn would increment it), and no dirty confirmation appears when clean.
    const generationBeforeReuse = statusAfterReopen.data.lease.generation;
    await c.page.click('[data-menu="file"]');
    await c.page.click('#project-library-open');
    await c.page.waitForSelector('#project-library', { timeout: 10000 });
    await c.page.click(`[data-library-open="${phase1.projectId}"]`);
    await c.page.waitForFunction(
        () => [...document.querySelectorAll('#toasts .toast')].some(toast => toast.textContent?.includes('已重开受管项目')),
        undefined, { timeout: 30000 });
    const statusAfterReuse = await c.page.evaluate(projectId => window.__dskCall('project.status', { projectId }), phase1.projectId);
    expect(statusAfterReuse.ok && statusAfterReuse.data.lease.generation === generationBeforeReuse,
        `a same-project reopen must reuse the session (generation ${generationBeforeReuse} → ${statusAfterReuse.data && statusAfterReuse.data.lease.generation})`);
    await c.page.click('.modal-footer [data-act="close-modal"]');
    await c.page.waitForSelector('#project-library', { state: 'detached', timeout: 10000 });
    console.log(`PHASE6.4c-OK: same-project reopen reused the live session (lease generation stayed at ${generationBeforeReuse})`);

    // 6.5 R11 pagination + status panel + explicit leave — REAL pointer and keyboard only (F11):
    // no dispatchEvent, no DOM click synthesis, no force. The rows container scrolls natively.
    await c.page.evaluate(async () => {
        for (let index = 0; index < 58; index++) {
            const created = await window.__dskCall('project.create', { name: '翻页项目' + String(index).padStart(2, '0') });
            if (created.ok) await window.__dskCall('storage.v1.project.close', { sessionId: created.data.sessionId });
        }
    });
    await c.page.click('[data-menu="file"]');
    await c.page.click('#project-library-open');
    await c.page.waitForSelector('#project-library', { timeout: 10000 });
    expect((await c.page.locator('[data-library-open]').count()) === 50, 'the first page must list exactly 50 projects');
    expect((await c.page.locator('[data-library-act="more"]').count()) === 1, 'nextCursor must surface the load-more button');
    const totalProjects = (await c.page.evaluate(async () => {
        let cursor, total = 0;
        do {
            const page = await window.__dskCall('storage.v1.project.list', { limit: 200, ...(cursor ? { cursor } : {}) });
            if (!page.ok) throw new Error(page.error.message);
            total += page.data.projects.length;
            cursor = page.data.nextCursor;
        } while (cursor);
        return total;
    }));
    // F11 keyboard reachability: focus the load-more button and activate it with Enter.
    await c.page.focus('[data-library-act="more"]');
    await c.page.keyboard.press('Enter');
    await c.page.waitForFunction(
        expected => document.querySelectorAll('[data-library-open]').length === expected
            && !document.querySelector('[data-library-act="more"]'),
        totalProjects, { timeout: 15000 });
    // F11 keyboard reachability for the per-row status query, then a real pointer click on leave.
    await c.page.focus(`[data-library-status="${phase1.projectId}"]`);
    await c.page.keyboard.press('Enter');
    await c.page.waitForFunction(
        () => document.querySelector('#library-status')?.textContent?.includes('租约'),
        undefined, { timeout: 15000 });
    const statusPanelText = await c.page.evaluate(() => document.querySelector('#library-status')?.textContent ?? '');
    expect(statusPanelText.includes('健康'), 'the status panel must render the integrity counters');
    const leaveButton = c.page.locator('[data-library-act="leave"]');
    await leaveButton.scrollIntoViewIfNeeded();
    await leaveButton.click();
    await c.page.waitForFunction(
        () => document.querySelector('#save-status')?.textContent === '普通会话（未管理）',
        undefined, { timeout: 15000 });
    const bootAfterLeave = await c.page.evaluate(() => window.__dskCall('storage.v1.session.bootstrap', {}));
    expect(bootAfterLeave.ok && bootAfterLeave.data.mode === 'unmanaged', `UI leave must persist unmanaged, got ${JSON.stringify(bootAfterLeave.data)}`);
    console.log('PHASE6.5-OK: library pagination (50 rows + nextCursor → 59), project.status panel (lease/integrity) and UI leave verified via real pointer and keyboard events');
    await c.browser.close();
    await terminate(childC);

    // 6.6 R6 startup isolation: an unusable library must NOT fall back to legacy recovery.
    const corruptStorage = path.join(root, 'tmp', `dsk-004-corrupt-storage-${process.pid}`);
    await fs.writeFile(corruptStorage, 'not-a-directory', 'utf8');
    const childE = launch(profiles[3], corruptStorage);
    const e = await waitReady(childE, profiles[3]);
    await e.page.waitForFunction(
        () => document.querySelector('#save-status')?.textContent === '项目库初始化失败',
        undefined, { timeout: 30000 });
    const eToasts = await e.page.evaluate(() => document.querySelector('#toasts')?.textContent ?? '');
    expect(eToasts.includes('项目库初始化失败'), 'the startup failure must be surfaced as a toast');
    expect(eToasts.includes('不读取旧自动恢复'), 'the failed bootstrap must NOT fall back to legacy recovery');
    console.log('PHASE6.6-OK: an unusable library surfaces the failure and skips legacy recovery at startup');
    await e.browser.close();
    await terminate(childE);

    // --- Phase 7 (RP1): a REAL page reload must synchronously invalidate in-flight requests ---
    // The real renderer reload fires did-start-loading in the real main process; every
    // session-bound artifact (session, upload transfer, tmp file) must be gone, the stale
    // session/transfer ids must not continue in the new generation, and fresh requests keep
    // working (RP1-A1/A4). The native-dialog backup invalidation itself stays on the RP8 /
    // manual boundary (CDP cannot drive the native directory picker).
    const childG = launch(profiles[4]);
    const g = await waitReady(childG, profiles[4]);
    await g.page.evaluate(pageCallHelper);
    const staleState = await g.page.evaluate(async payload => {
        const call = window.__dskCall;
        const created = await call('project.create', { name: '重载失效' });
        if (!created.ok) return { stage: 'create', reply: created };
        const sessionId = created.data.sessionId;
        const begin = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: payload.bytes });
        if (!begin.ok) return { stage: 'begin', reply: begin };
        const { transferId, chunkSize } = begin.data;
        const bytes = new TextEncoder().encode(payload.json);
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
            let binary = '';
            for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
            const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: btoa(binary) });
            if (!chunk.ok) return { stage: 'chunk', reply: chunk };
        }
        return { projectId: created.data.projectId, sessionId, transferId };
    }, { json: documentJson, bytes: documentBytes }).catch(error => ({ error: String(error) }));
    if (!(expect(!staleState.error && !!staleState.projectId, `RP1 stale-transfer staging failed: ${JSON.stringify(staleState)}`))) { }
    // Baseline BEFORE the reload: earlier phases may legitimately leave .part files behind when a
    // process is hard-killed (taskkill /F cannot run any cleanup; the exit drain is RP2 scope).
    // RP1 asserts the reload cleans exactly the transfer that is open HERE and creates nothing new.
    const uploadsDir = path.join(storageDir, 'uploads');
    const partsBeforeReload = fsSync.existsSync(uploadsDir) ? await fs.readdir(uploadsDir) : [];
    await g.page.reload(); // real reload → real did-start-loading → real session invalidation
    await g.page.waitForFunction(() => typeof window.directorDesktop?.dsk === 'function', undefined, { timeout: 30000 });
    await g.page.evaluate(pageCallHelper);
    const afterReload = await g.page.evaluate(async payload => {
        const call = window.__dskCall;
        return {
            staleActivate: await call('storage.v1.session.activate', { sessionId: payload.sessionId }),
            staleCommit: await call('storage.v1.upload.commit', { transferId: payload.transferId }),
            reopened: await call('project.open', { projectId: payload.projectId }),
        };
    }, staleState).catch(error => ({ error: String(error) }));
    if (!(expect(!afterReload.error, `RP1 post-reload evaluate failed: ${afterReload.error}`))) { }
    expect(!afterReload.staleActivate.ok, `a stale session id must be refused after reload: ${JSON.stringify(afterReload.staleActivate)}`);
    expect(!afterReload.staleCommit.ok, `a stale transfer id must be refused after reload: ${JSON.stringify(afterReload.staleCommit)}`);
    // The fire-and-forget drain (handle close + tmp rm) is async — poll briefly, then require it done.
    let partsAfterReload = fsSync.existsSync(uploadsDir) ? await fs.readdir(uploadsDir) : [];
    for (let waited = 0; waited < 5000 && partsAfterReload.includes(`${staleState.transferId}.part`); waited += 200) {
        await new Promise(resolve => setTimeout(resolve, 200));
        partsAfterReload = fsSync.existsSync(uploadsDir) ? await fs.readdir(uploadsDir) : [];
    }
    expect(!partsAfterReload.includes(`${staleState.transferId}.part`),
        `the real reload must remove the open transfer's .part file (${staleState.transferId}.part)`);
    const newParts = partsAfterReload.filter(name => name.endsWith('.part') && !partsBeforeReload.includes(name));
    expect(newParts.length === 0, `the reload must leave no new .part files, found ${JSON.stringify(newParts)}`);
    const freshGeneration = await g.page.evaluate(async payload => {
        if (!payload.reopened.ok) return { reopened: payload.reopened };
        const uploaded = await window.__dskUpload(payload.reopened.data.sessionId, payload.reopened.data.revision, payload.documentJson, '新代保存');
        const status = await window.__dskCall('project.status', { projectId: payload.projectId });
        return { uploaded, status };
    }, { ...staleState, reopened: afterReload.reopened, documentJson }).catch(error => ({ error: String(error) }));
    if (!(expect(!freshGeneration.error, `RP1 new-generation evaluate failed: ${freshGeneration.error}`))) { }
    expect(freshGeneration.uploaded && freshGeneration.uploaded.commit && freshGeneration.uploaded.commit.ok,
        `a new-generation save after reload must succeed: ${JSON.stringify(freshGeneration.uploaded)}`);
    expect(freshGeneration.status && freshGeneration.status.ok && freshGeneration.status.data.revision === 1,
        `the new-generation save must land revision 1: ${JSON.stringify(freshGeneration.status)}`);
    console.log('PHASE7-OK (RP1): a real reload invalidated the open session/transfer (stale ids refused, .part cleaned) and a new-generation save committed revision 1');
    await g.browser.close();
    await terminate(childG);
    await fs.rm(importPath, { force: true });
    await fs.rm(corruptStorage, { force: true });
    console.log('PHASE6-BOUNDARY: backup/restore via the real UI still require the native directory picker (not CDP-drivable) and the uncertain-save reopen condition (status.revision > managed.revision) cannot be produced without a genuinely lost commit receipt — both stay on the manual verification boundary.');
    await fs.rm(storageDir, { recursive: true, force: true });
    for (const profile of profiles) await fs.rm(profile, { recursive: true, force: true });

    if (!process.exitCode) console.log('DESKTOP-STORAGE-OK: managed snapshots, leases (two real processes: busy / expiry-takeover / generation / release) and bounded transfers verified on the prepared app.');
} catch (error) {
    fail(error && error.message ? error.message + ' || STACK: ' + String(error.stack).slice(0, 800) : String(error));
} finally {
    for (const child of children) await terminate(child).catch(() => { });
}
process.exit(process.exitCode || 0);
