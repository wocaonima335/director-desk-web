// RP5 acceptance (memory-bounded canonical serialization): loads the PRODUCTION
// shared/storage/canonical.ts and the PRODUCTION ManagedProjectController.saveSnapshot (esbuild
// bundles of the real TS sources) inside an ISOLATED Electron main process and an isolated
// renderer page, then measures process.memoryUsage().heapUsed immediately before/after each call.
// The retained heap increment must stay <= 167772160 bytes (160 MiB); gc() is forced on both
// sides of every measurement (v8 flags in main, --js-flags in the renderer) so the number
// reflects retained memory instead of uncollected garbage. RSS/external/arrayBuffers are
// printed as diagnostics only. Over-limit scenarios prove that fields AFTER the budget
// violation were never accessed (accessor side-effect canaries) and that saveSnapshot refused
// them without any upload.begin wire traffic. The script creates and cleans only its own
// tmp artifacts. Usage: node scripts/test-dsk-rp5-memory.mjs
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const root = path.resolve('.');
const require = createRequire(import.meta.url);
const LIMIT_BYTES = 167772160; // 160 MiB retained-heap increment budget per measured call
const GLOBAL_DEADLINE_MS = 300000;

let failed = false;
const fail = message => {
    failed = true;
    console.error('RP5-MEMORY-FAIL: ' + message);
};

// --- Generated scenario module (shared verbatim by the Electron main process and the renderer) --
// Written with String.raw so the generated CJS keeps the \uXXXX escape TEXT, which the Electron
// V8 parses into real (lone) surrogate strings at require time.
const scenariosSource = String.raw`
const LIMIT_BYTES = 167772160;
const utf8 = new TextEncoder();

async function runScenarios(helper, side) {
    const { canonicalJson, CanonicalLimitError, ManagedProjectController, STORAGE_MAX_PROJECT_BYTES: MAX } = helper;
    const results = [];
    const ok = (label, condition, detail) => {
        results.push({ side, kind: 'check', label, ok: !!condition, detail: detail || '' });
        return !!condition;
    };
    const measure = async (label, fn) => {
        const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
        if (gc) gc();
        const before = process.memoryUsage();
        let value, threw = null;
        try { value = await fn(); } catch (error) { threw = error; }
        if (gc) gc();
        const after = process.memoryUsage();
        const delta = after.heapUsed - before.heapUsed;
        results.push({
            side, kind: 'measure', label, delta: Number(delta), within: delta <= LIMIT_BYTES,
            heapBefore: before.heapUsed, heapAfter: after.heapUsed,
            rss: after.rss, external: after.external, arrayBuffers: after.arrayBuffers,
            note: gc ? 'gc-normalized' : 'gc-unavailable',
        });
        return { value, threw, delta };
    };

    // --- Fixtures (built OUTSIDE the measured windows) ----------------------------------------
    const probe = helper.readSceneDocument(helper.demoProject());
    const probeBytes = utf8.encode(canonicalJson(probe)).length;
    const nameBytes = utf8.encode(probe.name).length;
    const exactPad = MAX - probeBytes + nameBytes;
    const maxDocument = helper.readSceneDocument(helper.demoProject());
    maxDocument.name = 'x'.repeat(exactPad); // canonical form is exactly MAX bytes
    const overDocument = helper.readSceneDocument(helper.demoProject());
    overDocument.name = 'x'.repeat(exactPad + 1); // canonical form is exactly MAX+1 bytes
    const canaryState = { accessed: 0 };
    const canaryDocument = helper.readSceneDocument(helper.demoProject());
    canaryDocument.aaPadding = 'x'.repeat(MAX + 1024); // sorted before aaSentinel
    Object.defineProperty(canaryDocument, 'aaSentinel', {
        enumerable: true,
        get() { canaryState.accessed += 1; return 'must-never-be-read'; },
    });
    const nested = levels => { let value = 1; for (let i = 0; i < levels; i += 1) value = [value]; return value; };
    const nestedNull = levels => { let value = null; for (let i = 0; i < levels; i += 1) value = [value]; return value; };
    const deepOk = nested(63);   // leaf value sits at depth 64 (root counts as 1)
    const deepBad = nested(64);  // leaf value would sit at depth 65
    const deepNullOk = nestedNull(63);   // null leaf at depth 64 (legal)
    const deepNullBad = nestedNull(64);  // null leaf would sit at depth 65
    const nodesOk = new Array(999999).fill(1);   // root + 999999 = exactly 1000000 nodes
    const nodesBad = new Array(1000000).fill(1); // root + 1000000 = 1000001 nodes
    // Warm-up accounting pass: the fixtures above were allocated OUTSIDE every measured window,
    // and V8 only accounts large-object-space strings once a GC has touched them. One forced GC
    // here charges the fixtures to the BASELINE so each measured increment reflects the call
    // itself (success keeps one canonical text; aborts keep nothing) rather than fixture churn.
    if (typeof globalThis.gc === 'function') globalThis.gc();

    // --- canonicalJson: memory around the exact-budget and over-budget calls ------------------
    const exact = await measure('canonical/exact-' + MAX, () => canonicalJson(maxDocument));
    ok('canonical/exact produces exactly MAX bytes', !exact.threw && utf8.encode(exact.value).length === MAX,
        exact.threw ? String(exact.threw.message) : 'byteLength=' + utf8.encode(exact.value).length);
    const over = await measure('canonical/reject-' + (MAX + 1), () => canonicalJson(overDocument));
    ok('canonical/(MAX+1) aborts with the bytes limit', !!over.threw && over.threw.limit === 'bytes',
        over.threw ? over.threw.limit + ': ' + over.threw.message : 'no throw');
    const canary = await measure('canonical/over-limit-canary-untouched', () => canonicalJson(canaryDocument));
    ok('canonical over-limit stops before later fields', !!canary.threw && canary.threw.limit === 'bytes' && canaryState.accessed === 0,
        'limit=' + (canary.threw && canary.threw.limit) + ' sentinelReads=' + canaryState.accessed);

    // --- canonicalJson: budget boundaries and byte compatibility (logical, small) -------------
    let deepOkOk = true, deepBadOk = true;
    try { canonicalJson(deepOk); } catch (error) { deepOkOk = false; }
    try { canonicalJson(deepBad); deepBadOk = false; } catch (error) { deepBadOk = error instanceof CanonicalLimitError && error.limit === 'depth'; }
    ok('canonical depth 64 legal / 65 rejected as depth', deepOkOk && deepBadOk, 'ok=' + deepOkOk + ' bad=' + deepBadOk);
    let deepNullOkOk = true, deepNullBadOk = true;
    try { canonicalJson(deepNullOk); } catch (error) { deepNullOkOk = false; }
    try { canonicalJson(deepNullBad); deepNullBadOk = false; } catch (error) { deepNullBadOk = error instanceof CanonicalLimitError && error.limit === 'depth'; }
    ok('canonical array null obeys depth+1: null at depth 64 legal / 65 rejected as depth', deepNullOkOk && deepNullBadOk, 'ok=' + deepNullOkOk + ' bad=' + deepNullBadOk);
    let nodesOkOk = true, nodesBadOk = true;
    try { canonicalJson(nodesOk); } catch (error) { nodesOkOk = false; }
    try { canonicalJson(nodesBad); nodesBadOk = false; } catch (error) { nodesBadOk = error instanceof CanonicalLimitError && error.limit === 'nodes'; }
    ok('canonical 1000000 nodes legal / 1000001 rejected as nodes', nodesOkOk && nodesBadOk, 'ok=' + nodesOkOk + ' bad=' + nodesBadOk);
    let finiteOk = false;
    try { canonicalJson({ bad: Number.NaN }); } catch (error) { finiteOk = error.message.indexOf('\u975e\u6709\u9650\u6570') !== -1; }
    ok('canonical rejects non-finite numbers', finiteOk);
    ok('canonical key order matches JSON.stringify(sorted object): integer indices numeric-first, other keys code-unit',
        canonicalJson({ 10: 'a', 2: 'b', 1: 'c' }) === '{"1":"c","2":"b","10":"a"}'
        && canonicalJson({ 10: 'a', 2: 'b', 1: 'c', '2x': 'd', '01': 'e', '-1': 'f', z: 'g', A: 'h' }) === '{"1":"c","2":"b","10":"a","-1":"f","01":"e","2x":"d","A":"h","z":"g"}');
    ok('canonical escapes match JSON.stringify (controls, quotes, lone surrogate)',
        canonicalJson({ k: 'a"b\\c\nd' + String.fromCharCode(1) }) === '{"k":"a\\"b\\\\c\\nd\\u0001"}'
        && canonicalJson({ s: '\ud800' }) === '{"s":"\\ud800"}');
    ok('canonical UTF-8 accounting: {"s":X} = 2 braces + key + colon + quotes + value bytes',
        utf8.encode(canonicalJson({ s: '\u6587' })).length === 11
        && utf8.encode(canonicalJson({ s: '\ud800'.repeat(4) })).length === 32
        && utf8.encode(canonicalJson({ s: '\u{1D306}' })).length === 12);

    // --- renderer only: PRODUCTION saveSnapshot memory and refusal behavior -------------------
    if (side === 'renderer') {
        const ref = { version: 'dsk.v1', snapshotId: 'snap-rp5', projectId: 'proj-rp5', revision: 1, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
        const runSave = async document => {
            const wire = [];
            const controller = new ManagedProjectController(async (action, data) => {
                wire.push({ action, data });
                if (action === 'storage.v1.upload.begin') return { ok: true, data: { transferId: 'up-rp5', declaredLength: data.declaredLength, chunkSize: 65536 } };
                if (action === 'storage.v1.upload.chunk') return { ok: true, data: { received: data.offset + 65536 } };
                if (action === 'storage.v1.upload.commit') return { ok: true, data: { snapshot: ref, revision: 1 } };
                return { ok: true, data: {} };
            });
            controller.restoreBinding({ sessionId: 'sess-rp5', projectId: 'proj-rp5', projectName: 'rp5', revision: 2, current: ref, leaseOwned: true });
            controller.identity = 'managed';
            const outcome = await controller.saveSnapshot(document);
            const begin = wire.find(entry => entry.action === 'storage.v1.upload.begin');
            return {
                outcome,
                wire: wire.map(entry => entry.action),
                declaredLength: begin ? begin.data.declaredLength : null,
                chunks: wire.filter(entry => entry.action === 'storage.v1.upload.chunk').length,
                revision: controller.revision,
                currentSnapshot: controller.current && controller.current.snapshotId,
            };
        };
        const saveExact = await measure('saveSnapshot/exact-' + MAX, () => runSave(maxDocument));
        const savedOk = !saveExact.threw && saveExact.value.outcome.status === 'saved'
            && saveExact.value.declaredLength === MAX
            && saveExact.value.chunks === Math.ceil(MAX / 65536)
            && saveExact.value.revision === 1 && saveExact.value.currentSnapshot === 'snap-rp5';
        ok('saveSnapshot commits the exact-budget document (chunks + revision updated)', savedOk,
            saveExact.threw ? String(saveExact.threw.message) : JSON.stringify(saveExact.value.outcome));
        const saveOver = await measure('saveSnapshot/reject-' + (MAX + 1), () => runSave(overDocument));
        const overOk = !saveOver.threw && saveOver.value.outcome.status === 'failed'
            && saveOver.value.outcome.reason === 'upload-too-large'
            && saveOver.value.wire.length === 0
            && saveOver.value.revision === 2 && saveOver.value.currentSnapshot === 'snap-rp5';
        ok('saveSnapshot refuses MAX+1 bytes locally (upload-too-large, no wire, binding untouched)', overOk,
            saveOver.threw ? String(saveOver.threw.message) : JSON.stringify(saveOver.value.outcome));
        const saveCanary = await measure('saveSnapshot/over-limit-canary-untouched', () => runSave(canaryDocument));
        ok('saveSnapshot over-limit never reads later fields and never calls upload.begin',
            !saveCanary.threw && saveCanary.value.outcome.reason === 'upload-too-large'
            && canaryState.accessed === 0 && saveCanary.value.wire.length === 0,
            'sentinelReads=' + canaryState.accessed + ' wire=' + JSON.stringify(saveCanary.value.wire));
        const invalid = async (label, document) => {
            const run = await measure(label, () => runSave(document));
            return !run.threw && run.value.outcome.status === 'failed'
                && run.value.outcome.reason === 'document-invalid'
                && run.value.wire.length === 0
                && run.value.revision === 2;
        };
        const deepDoc = helper.readSceneDocument(helper.demoProject());
        deepDoc.zzDepth = deepBad;
        ok('saveSnapshot depth 65 -> document-invalid without wire', await invalid('saveSnapshot/invalid-depth', deepDoc));
        const nodesDoc = helper.readSceneDocument(helper.demoProject());
        nodesDoc.zzNodes = nodesBad;
        ok('saveSnapshot 1000001 nodes -> document-invalid without wire', await invalid('saveSnapshot/invalid-nodes', nodesDoc));
        const nanDoc = helper.readSceneDocument(helper.demoProject());
        nanDoc.zzFinite = Number.NaN;
        ok('saveSnapshot non-finite value -> document-invalid without wire', await invalid('saveSnapshot/invalid-nonfinite', nanDoc));
        // A root that yields no canonical text at all (undefined) is refused at the save entry.
        ok('saveSnapshot JSON-invisible root (undefined) -> document-invalid without wire', await invalid('saveSnapshot/invalid-root-undefined', undefined));
    }
    return results;
}
module.exports = { runScenarios };
`;

// --- Generated Electron main entry --------------------------------------------------------------
const mainEntrySource = String.raw`
const { app, BrowserWindow } = require('electron');
const v8 = require('node:v8');
const vm = require('node:vm');
// Expose gc() inside renderer isolates so retained-heap measurements are deterministic there.
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.setPath('userData', process.env.RP5_USER_DATA);
// Classic Node/V8 trick: enable --expose-gc for THIS isolate after boot and fetch gc from a new
// context (the Electron main process has no --expose-gc CLI surface of its own).
v8.setFlagsFromString('--expose_gc');
const gcMain = vm.runInNewContext('typeof gc === "function" ? gc : null');
if (gcMain) globalThis.gc = gcMain;

const report = payload => process.stdout.write('RP5-RESULT ' + JSON.stringify(payload) + '\n');
const flushExit = code => setTimeout(() => app.exit(code), 150);

app.whenReady().then(async () => {
    const helper = require(process.env.RP5_BUNDLE);
    const { runScenarios } = require(process.env.RP5_SCENARIOS);
    for (const result of await runScenarios(helper, 'main')) report(result);
    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    const harness = '(async () => {' +
        'const helper = require(' + JSON.stringify(process.env.RP5_BUNDLE) + ');' +
        'const { runScenarios } = require(' + JSON.stringify(process.env.RP5_SCENARIOS) + ');' +
        'return await runScenarios(helper, "renderer"); })()';
    // A real file:// page (not data:) is a secure context, so the production document factory's
    // crypto.randomUUID() calls work exactly like in the shipped renderer.
    await win.loadFile(process.env.RP5_HTML);
    for (const result of await win.webContents.executeJavaScript(harness, true)) report(result);
    process.stdout.write('RP5-DONE\n');
    flushExit(0);
}).catch(error => {
    process.stdout.write('RP5-FATAL ' + String(error && error.stack ? error.stack : error) + '\n');
    flushExit(1);
});
`;

// --- Runner -------------------------------------------------------------------------------------
const tmp = path.join(root, 'tmp');
const suffix = String(process.pid);
const helperBundle = path.join(tmp, `dsk-rp5-helper-${suffix}.cjs`);
const scenariosFile = path.join(tmp, `dsk-rp5-scenarios-${suffix}.cjs`);
const mainEntryFile = path.join(tmp, `dsk-rp5-main-${suffix}.cjs`);
const userDataDir = path.join(tmp, `dsk-rp5-userdata-${suffix}`);
const harnessHtml = path.join(tmp, `dsk-rp5-page-${suffix}.html`);
const ownFiles = [helperBundle, scenariosFile, mainEntryFile, harnessHtml];
const cleanup = () => {
    for (const file of ownFiles) { try { fsSync.rmSync(file, { force: true }); } catch { /* own files only */ } }
    try { fsSync.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* own dir only */ }
};
process.on('exit', cleanup);

let electronPath;
try { electronPath = require('electron'); } catch (error) {
    fail(`electron is not installed/resolvable: ${error.message}`);
    process.exit(1);
}
if (typeof electronPath !== 'string' || !fsSync.existsSync(electronPath)) {
    fail(`electron path is not a runnable binary: ${String(electronPath)}`);
    process.exit(1);
}

await esbuild.build({
    stdin: {
        contents: [
            "export { readSceneDocument } from './src/scenes/sequence-project.ts';",
            "export { demoProject } from './src/model.ts';",
            "export { canonicalJson, CanonicalLimitError } from './shared/storage/canonical.ts';",
            "export { ManagedProjectController } from './src/editor/managed-project.ts';",
            "export { STORAGE_MAX_PROJECT_BYTES } from './shared/contracts/index.ts';",
        ].join('\n'),
        resolveDir: root, loader: 'ts',
    },
    outfile: helperBundle, bundle: true, platform: 'browser', format: 'cjs', logLevel: 'silent',
});
fsSync.mkdirSync(tmp, { recursive: true });
fsSync.writeFileSync(scenariosFile, scenariosSource, 'utf8');
fsSync.writeFileSync(mainEntryFile, mainEntrySource, 'utf8');
fsSync.writeFileSync(harnessHtml, '<!doctype html><html><title>rp5-memory</title><body>rp5</body></html>', 'utf8');
await fs.mkdir(userDataDir, { recursive: true });

const child = spawn(electronPath, [mainEntryFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
        ...process.env,
        RP5_BUNDLE: helperBundle,
        RP5_SCENARIOS: scenariosFile,
        RP5_USER_DATA: userDataDir,
        RP5_HTML: harnessHtml,
        ELECTRON_ENABLE_LOGGING: '0',
    },
});
let stderrTail = '';
child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });

const deadline = setTimeout(() => {
    fail(`global deadline (${GLOBAL_DEADLINE_MS / 1000}s) exceeded; killing the isolated Electron`);
    try { child.kill(); } catch { /* best effort */ }
}, GLOBAL_DEADLINE_MS).unref();

const results = [];
let fatal = null;
let done = false;
let pending = Buffer.alloc(0);
child.stdout.on('data', chunk => {
    const text = Buffer.concat([pending, chunk]).toString('utf8');
    const lines = text.split('\n');
    pending = Buffer.from(lines.pop() ?? '', 'utf8');
    for (const line of lines) {
        if (line.startsWith('RP5-RESULT ')) {
            try { results.push(JSON.parse(line.slice('RP5-RESULT '.length))); } catch (error) { fail(`unparsable result line: ${line.slice(0, 200)} (${error.message})`); }
        } else if (line.startsWith('RP5-FATAL ')) {
            fatal = line.slice('RP5-FATAL '.length);
        } else if (line.trim() === 'RP5-DONE') {
            done = true;
        }
    }
});

const exitCode = await new Promise(resolve => {
    child.once('exit', (code, signal) => resolve(code === null ? signal : code));
});
clearTimeout(deadline);

let measures = 0;
for (const result of results) {
    const label = `[${result.side}] ${result.label}`;
    if (result.kind === 'measure') {
        measures += 1;
        console.log(`MEASURE ${label}: heapUsed delta=${result.delta} bytes (budget ${LIMIT_BYTES}) within=${result.within} note=${result.note} | diagnostics: rss=${result.rss} external=${result.external} arrayBuffers=${result.arrayBuffers} heapBefore=${result.heapBefore} heapAfter=${result.heapAfter}`);
        if (!result.within) fail(`${label}: retained heap increment ${result.delta} exceeds ${LIMIT_BYTES}`);
    } else if (!result.ok) {
        fail(`${label}: ${result.detail}`);
    } else {
        console.log(`CHECK ${label}: ok (${result.detail})`);
    }
}

if (fatal) fail(`isolated Electron crashed: ${fatal.slice(0, 1200)}`);
if (!done && !fatal) fail(`isolated Electron did not report completion (exit=${exitCode}); stderr tail: ${stderrTail.slice(-800) || '(empty)'}`);
if (measures === 0) fail('no memory measurements were reported');

if (!failed) {
    console.log(`RP5-MEMORY-OK: production canonicalJson (main+renderer) and production saveSnapshot (renderer) stayed within the ${LIMIT_BYTES}-byte retained-heap budget across ${measures} measured calls; over-limit scenarios stopped before later fields and never called upload.begin.`);
}
process.exit(failed ? 1 : 0);
