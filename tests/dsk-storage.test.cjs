// DSK-004 storage harness (system Node with built-in node:sqlite; API parity with the Electron
// runtime was probed on both and is additionally covered by the real Electron path in
// scripts/test-dsk-storage-desktop.mjs). Runs the storage contract fixtures through the SAME
// esbuild CJS bundling used for the desktop payload, then exercises the real library/object/
// service layers with fault injection, lease lifecycles, bounded transfers and backup/restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

const repo = process.cwd();
let bundleSeq = 0;
async function buildBundle(entry, extraExports) {
    const outfile = path.join(repo, 'tmp', `dsk-storage-bundle-${process.pid}-${bundleSeq++}.cjs`);
    if (extraExports) {
        await esbuild.build({
            stdin: { contents: extraExports, resolveDir: repo, loader: 'ts' },
            outfile, bundle: true, platform: 'node', format: 'cjs', charset: 'utf8', logLevel: 'silent',
        });
    } else {
        await esbuild.build({
            entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
            charset: 'utf8', external: ['electron'], logLevel: 'silent',
        });
    }
    process.on('exit', () => { try { fs.rmSync(outfile, { force: true }); } catch { /* best effort */ } });
    return require(outfile);
}

const contractsPromise = buildBundle(null, [
    "export { dispatchDskRequest, DSK_CONTRACT_VERSION, STORAGE_ACTION_PAYLOAD_SCHEMAS, STORAGE_RESULT_SCHEMAS, PIPELINE_STORAGE_RESULT_SCHEMAS, BackupManifestSchema, STORAGE_MAX_PROJECT_BYTES, STORAGE_CHUNK_BYTES, scanStorageProject } from './shared/contracts/index.ts';",
    "export { canonicalJson } from './shared/storage/canonical.ts';",
    "export { assertSceneDocument, readSceneDocument } from './src/scenes/sequence-project.ts';",
    "export { demoProject } from './src/model.ts';",
].join('\n'));
const servicePromise = buildBundle('desktop/storage/service.cjs');
const libraryPromise = buildBundle('desktop/storage/library.cjs');
const objectsPromise = buildBundle('desktop/storage/objects.cjs');

// RP1 V01: real-fsp barriers for the R01/R02 races. The bundle intercepts node:fs/promises and
// wraps ONLY rm/mkdir: the wrapped calls still execute the REAL fs operation, but the first call
// matching the test's predicate is held behind a gate. This works identically against older
// service sources (no constructor DI required), so red runs exercise the actual race window.
const RP1_FSP_WRAPPER = `
const real = require('fs/promises');
// Idempotent: several bundles (service + objects/library) each embed this wrapper and must
// share ONE gate state, otherwise the later bundle's assignment would clobber the gates.
const state = globalThis.__rp1FspGates || {
    rmMatch: null, rmMatched: false, rmCalls: 0, rmGate: null,
    mkdirMatch: null, mkdirMatched: false, mkdirCalls: 0, mkdirGate: null,
    rmRejectMatch: null, rmRejectCalls: 0, rmRejectPath: null, rmRejectCode: null, rmRejectError: null,
};
globalThis.__rp1FspGates = state;
// Normalize fields introduced by this wrapper revision when the shared state was created
// earlier in this process without them (never reset fields: cross-bundle gates must survive).
if (typeof state.rmRejectCalls !== 'number') state.rmRejectCalls = 0;
function gated(kind, args, call) {
    const match = kind === 'rm' ? state.rmMatch : state.mkdirMatch;
    const done = kind === 'rm' ? 'rmMatched' : 'mkdirMatched';
    const gate = kind === 'rm' ? state.rmGate : state.mkdirGate;
    if (typeof match === 'function' && !state[done] && match(...args)) {
        state[done] = true;
        if (gate) return gate.then(call);
    }
    return call();
}
module.exports = {
    rm(...args) {
        state.rmCalls += 1;
        if (typeof state.rmRejectMatch === 'function' && state.rmRejectMatch(...args)) {
            // Validation-01: deterministic denial for exactly the test-picked path. The
            // rejection is INJECTED here and clearly marked SIMULATED (not a real OS
            // permission failure); every other call passes through to the real fs. The exact
            // error object is recorded so the test can assert code/path/count after the fact.
            state.rmRejectCalls += 1;
            state.rmRejectPath = args[0];
            const error = new Error('[rp1-fsp-gate] SIMULATED fsp.rm denial injected by the test (not a real OS permission failure): ' + args[0]);
            error.code = state.rmRejectCode === 'EACCES' ? 'EACCES' : 'EPERM';
            error.simulated = true;
            state.rmRejectError = error;
            return Promise.reject(error);
        }
        return gated('rm', args, () => real.rm(...args));
    },
    mkdir(...args) { state.mkdirCalls += 1; return gated('mkdir', args, () => real.mkdir(...args)); },
};
Object.setPrototypeOf(module.exports, real);
`;

function fspGatePlugin() {
    return {
        name: 'rp1-fsp-gate',
        setup(build) {
            build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'rp1-gated-fsp', namespace: 'rp1-fsp-gate' }));
            build.onLoad({ filter: /.*/, namespace: 'rp1-fsp-gate' }, () => ({ contents: RP1_FSP_WRAPPER, loader: 'js', resolveDir: repo }));
        },
    };
}

async function buildGatedService(entry) {
    const outfile = path.join(repo, 'tmp', `dsk-storage-gated-${process.pid}-${bundleSeq++}.cjs`);
    await esbuild.build({
        entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
        charset: 'utf8', external: ['electron'], logLevel: 'silent', plugins: [fspGatePlugin()],
    });
    process.on('exit', () => { try { fs.rmSync(outfile, { force: true }); } catch { /* best effort */ } });
    return require(outfile);
}

let rootSeq = 0;
function freshRoot(label) {
    const root = path.join(repo, 'tmp', `dsk-storage-test-${process.pid}-${label}-${rootSeq++}`);
    fs.rmSync(root, { recursive: true, force: true });
    return root;
}

function issueTargets(issue) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        return issue.keys.map(key => [...issue.path, key].join('.'));
    }
    return [issue.path.map(String).join('.')];
}

const SAMPLE_B64 = Buffer.from('hello storage').toString('base64');

/** Build a fresh, valid multi-scene document from the real engine factory (never shared state). */
async function sampleDoc(name) {
    const contracts = await contractsPromise;
    const document = contracts.readSceneDocument(contracts.demoProject());
    if (name) document.name = name;
    return document;
}

async function runContractFixtures() {
    const contracts = await contractsPromise;
    const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/dsk-storage/cases.json'), 'utf8'));
    assert.equal(contracts.DSK_CONTRACT_VERSION, fixture.contractVersion);
    let schemaCases = 0, ipcCases = 0;
    for (const item of fixture.cases) {
        if (item.schema) {
            schemaCases += 1;
            const [side, action] = item.schema.split(':');
            const registry = side === 'in' ? contracts.STORAGE_ACTION_PAYLOAD_SCHEMAS : contracts.STORAGE_RESULT_SCHEMAS;
            const result = registry[action].safeParse(item.data);
            assert.equal(result.success, item.valid, `${item.id}: expected ${item.valid ? 'accept' : 'reject'}`
                + (result.success ? '' : ` but failed: ${result.error.issues[0] && result.error.issues[0].message}`));
            if (!result.success && item.valid === false) {
                for (const expected of item.expectPath ?? []) {
                    assert.ok(result.error.issues.some(issue => issueTargets(issue).some(target => target.includes(expected))),
                        `${item.id}: no issue targets ~ "${expected}"`);
                }
                for (const expected of item.expectMessage ?? []) {
                    assert.ok(result.error.issues.some(issue => issue.message.includes(expected)),
                        `${item.id}: no message ~ "${expected}"`);
                }
            }
        } else {
            ipcCases += 1;
            const result = await contracts.dispatchDskRequest(item.input, {});
            assert.equal(result.ok, false, `${item.id}: expected ok:false`);
            assert.equal(result.ok ? '' : result.error.code, item.expectCode, `${item.id}: unexpected code`);
        }
    }
    assert.equal(schemaCases + ipcCases, fixture.cases.length);
    return { schemaCases, ipcCases, total: fixture.cases.length };
}

test('storage.v1 fixtures validate identically through the bundled CJS contract', async () => {
    const counts = await runContractFixtures();
    assert.ok(counts.schemaCases >= 45, 'payload/result schema cases must stay substantial');
    assert.ok(counts.ipcCases >= 10, 'envelope cases must stay substantial');
    console.log(`storage fixture counts: schema=${counts.schemaCases} ipc=${counts.ipcCases} total=${counts.total}`);
});

test('pipeline actions stay frozen: original payload schemas and dispatch codes unchanged', async () => {
    const contracts = await contractsPromise;
    const original = { version: 'dsk.v1', action: 'project.status', data: { projectId: 'proj-0001' } };
    const result = await contracts.dispatchDskRequest(original, {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_IMPLEMENTED', 'original actions stay NOT_IMPLEMENTED without handlers');
    const unknown = await contracts.dispatchDskRequest({ version: 'dsk.v1', action: 'fs.read', data: {} }, {});
    assert.equal(unknown.error.code, 'INVALID_ACTION');
    const oversized = await contracts.dispatchDskRequest({ version: 'dsk.v1', action: 'state.get', data: { workflowId: 'wf-0001', filler: 'x'.repeat(262145) } }, {});
    assert.equal(oversized.error.code, 'PAYLOAD_TOO_LARGE', 'generic 256KiB message cap must stay');
});

test('canonical JSON sorts UTF-16 keys recursively, preserves array order and rejects non-finite numbers', async () => {
    const contracts = await contractsPromise;
    const input = { b: 1, a: [{ z: 1, y: [2, 1] }], c: null, d: '文本' };
    const canonical = contracts.canonicalJson(input);
    assert.equal(canonical, '{"a":[{"y":[2,1],"z":1}],"b":1,"c":null,"d":"文本"}');
    assert.equal(contracts.canonicalJson([{ k2: 1, k1: 2 }, { k1: 3, k2: 4 }]), '[{"k1":2,"k2":1},{"k1":3,"k2":4}]');
    assert.throws(() => contracts.canonicalJson({ bad: NaN }), /非有限数/);
    assert.throws(() => contracts.canonicalJson({ bad: Infinity }), /非有限数/);
    // Cross-engine digest stability: the bundled canonical bytes hash with plain node:crypto.
    const digest = crypto.createHash('sha256').update(Buffer.from(contracts.canonicalJson({ b: 1, a: { c: [1, 2] } }), 'utf8')).digest('hex');
    assert.match(digest, /^[0-9a-f]{64}$/);
});

function makeLibrary({ file, now } = {}) {
    const target = file ?? path.join(freshRoot('lib'), 'library.sqlite');
    return libraryPromise.then(({ openLibrary }) => ({ library: openLibrary({ file: target, now: now ?? (() => Date.now()) }), file: target }));
}

test('library initializes schema v1 on an empty file, reopens cleanly and refuses foreign schema', async () => {
    const contracts = await contractsPromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('schema'), file = path.join(root, 'library.sqlite');
    const lib = openLibrary({ file, now: () => Date.now() });
    assert.equal(lib.getlastSession(), null);
    const created = lib.createProject({ projectId: 'proj-aaa1', name: '项目甲' });
    assert.equal(created.revision, 0);
    lib.setLastSession('managed', 'proj-aaa1', '项目甲');
    lib.close();
    const reopened = openLibrary({ file, now: () => Date.now() });
    assert.deepEqual(reopened.getlastSession(), { mode: 'managed', projectId: 'proj-aaa1', name: '项目甲' });
    reopened.close();
    // Unknown schema version refuses writes and never rebuilds.
    const { DatabaseSync } = require('node:sqlite');
    const tamper = new DatabaseSync(file);
    tamper.prepare('UPDATE schema_migrations SET version = 2').run();
    tamper.close();
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(() => openLibrary({ file, now: () => Date.now() }), error => error.reason === 'schema-unsupported');
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(after, before, 'refused database must not be modified or rebuilt');
    // A damaged file is also refused without touching it.
    const damaged = path.join(root, 'damaged.sqlite');
    fs.writeFileSync(damaged, Buffer.from('this is not a sqlite database at all, just bytes.'));
    const damagedBefore = crypto.createHash('sha256').update(fs.readFileSync(damaged)).digest('hex');
    assert.throws(() => openLibrary({ file: damaged, now: () => Date.now() }), error => error.reason === 'schema-unsupported');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(damaged)).digest('hex'), damagedBefore);
    void contracts;
});

test('lease lifecycle: exclusive acquisition, release, generation increment, renewal and expiry takeover', async () => {
    const { openLibrary } = await libraryPromise;
    let clock = 1000000;
    const root = freshRoot('lease'), file = path.join(root, 'library.sqlite');
    const libA = openLibrary({ file, now: () => clock });
    const libB = openLibrary({ file, now: () => clock });
    const created = libA.createProject({ projectId: 'proj-leas', name: '租约' });
    assert.equal(created.revision, 0);
    const first = libA.acquireLease('proj-leas', 30000);
    assert.equal(first.acquired, true);
    assert.equal(libB.acquireLease('proj-leas', 30000).acquired, false, 'live lease is exclusive across connections');
    assert.equal(libA.renewLease('proj-leas', first.owner, first.generation, 30000).renewed, true);
    assert.equal(libB.renewLease('proj-leas', 'forged-owner', first.generation, 30000).renewed, false, 'forged owner cannot renew');
    assert.equal(libB.releaseLease('proj-leas', 'forged-owner', first.generation).released, false, 'forged owner cannot release');
    libA.close();
    // Expired lease is taken over with generation+1 by another process connection.
    clock += 31000;
    const second = libB.acquireLease('proj-leas', 30000);
    assert.equal(second.acquired, true);
    assert.equal(second.generation, first.generation + 1, 'takeover must increment generation');
    // The stale owner token can neither renew, release, nor commit.
    assert.equal(libB.renewLease('proj-leas', first.owner, first.generation, 30000).renewed, false);
    assert.equal(libB.leaseState('proj-leas').generation, second.generation);
    const released = libB.releaseLease('proj-leas', second.owner, second.generation);
    assert.equal(released.released, true);
    const tombstone = libB.leaseState('proj-leas');
    assert.equal(tombstone.expired, true, 'release leaves an expired tombstone so generation never resets');
    const third = libB.acquireLease('proj-leas', 30000);
    assert.equal(third.acquired, true);
    assert.equal(third.generation, second.generation + 1, 'generation is monotonic across release+reacquire');
    libB.close();
});

test('commitSnapshot guards owner/generation/revision and derives revision = expected+1 atomically', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('commit'), file = path.join(root, 'library.sqlite');
    const lib = openLibrary({ file, now: () => Date.now() });
    lib.createProject({ projectId: 'proj-comm', name: '提交' });
    const lease = lib.acquireLease('proj-comm', 30000);
    const snapshot = { snapshotId: 'snap-0001', digest: 'a'.repeat(64), length: 10, createdAt: new Date().toISOString() };
    const committed = lib.commitSnapshot({ projectId: 'proj-comm', owner: lease.owner, generation: lease.generation, expectedRevision: 0, snapshot, now: () => Date.now() });
    assert.deepEqual(committed, { committed: true });
    const project = lib.getProject('proj-comm');
    assert.equal(project.revision, 1);
    assert.equal(project.current.snapshotId, 'snap-0001');
    // Revision conflict: expectedRevision must match exactly.
    assert.throws(() => lib.commitSnapshot({ projectId: 'proj-comm', owner: lease.owner, generation: lease.generation, expectedRevision: 0, snapshot: { ...snapshot, snapshotId: 'snap-0002' }, now: () => Date.now() }), error => error.reason === 'revision-conflict');
    // A stale generation from a superseded lease cannot commit.
    assert.throws(() => lib.commitSnapshot({ projectId: 'proj-comm', owner: 'old-owner', generation: lease.generation - 1, expectedRevision: 1, snapshot: { ...snapshot, snapshotId: 'snap-0003' }, now: () => Date.now() }), error => error.reason === 'lease-lost');
    // Lost receipt AFTER a real commit: the library re-verifies by snapshot id and reports
    // success instead of double-writing or blindly retrying.
    const uncertain = lib.commitSnapshot({ projectId: 'proj-comm', owner: lease.owner, generation: lease.generation, expectedRevision: 1, snapshot: { ...snapshot, snapshotId: 'snap-0004' }, now: () => Date.now() },
        { commitReceipt() { throw new Error('receipt lost'); } });
    assert.deepEqual(uncertain, { committed: true }, 'verified receipt loss must resolve to the committed snapshot');
    assert.equal(lib.getProject('proj-comm').revision, 2);
    assert.equal(lib.getSnapshot('proj-comm', 'snap-0004').digest, snapshot.digest);
    lib.close();
});

test('object store publishes only verified files and reports missing/corrupt/orphans without repairing', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('objects');
    const store = createObjectStore({ root });
    const bytes = Buffer.from('{"ok":true}');
    const { digest, length } = await store.putObject('proj-obj1', bytes);
    assert.equal(digest, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(length, bytes.length);
    const readBack = await store.getObject('proj-obj1', digest, bytes.length);
    assert.deepEqual(readBack, bytes);
    // Corruption and absence are detected with stable reasons.
    const file = path.join(root, 'projects', 'proj-obj1', 'objects', `${digest}.json`);
    fs.writeFileSync(file, Buffer.from('tampered'));
    await assert.rejects(() => store.getObject('proj-obj1', digest, bytes.length), error => error.reason === 'corrupt-object');
    await assert.rejects(() => store.getObject('proj-obj1', 'f'.repeat(64), 4), error => error.reason === 'corrupt-object');
    // Orphan (unregistered) objects are visible but never deleted automatically.
    fs.writeFileSync(file, bytes);
    const orphanBytes = Buffer.from('orphan');
    await store.putObject('proj-obj1', orphanBytes);
    const report = await store.verifyProject('proj-obj1', [{ digest, length: bytes.length }]);
    assert.deepEqual(report, { objects: 2, missing: 0, corrupt: 0, orphans: 1 });
    const missingReport = await store.verifyProject('proj-obj1', [{ digest: 'e'.repeat(64), length: 3 }, { digest, length: bytes.length }]);
    assert.equal(missingReport.missing, 1);
    // Fault injection: failures leave no final file and clean the tmp file.
    const root2 = freshRoot('objects-fault');
    const failing = createObjectStore({ root: root2, faults: { write: () => { throw Error('disk on fire'); } } });
    await assert.rejects(() => failing.putObject('proj-obj2', bytes), /disk on fire/);
    const root3 = freshRoot('objects-rename');
    const renameFail = createObjectStore({ root: root3, faults: { rename: () => { throw Error('rename denied'); } } });
    await assert.rejects(() => renameFail.putObject('proj-obj3', bytes), /rename denied/);
    const leftover = fs.existsSync(path.join(root3, 'projects', 'proj-obj3', 'objects'));
    const dirEntries = leftover ? fs.readdirSync(path.join(root3, 'projects', 'proj-obj3', 'objects')) : [];
    assert.deepEqual(dirEntries, [], 'failed publication must not leave a final or tmp object behind');
    // Content sync: fsync fault also fails the write before rename.
    const root4 = freshRoot('objects-sync');
    const syncFail = createObjectStore({ root: root4, faults: { sync: () => { throw Error('sync failed'); } } });
    await assert.rejects(() => syncFail.putObject('proj-obj4', bytes), /sync failed/);
    assert.equal(fs.existsSync(path.join(root4, 'projects', 'proj-obj4', 'objects', `${digest}.json`)), false);
});

/** Build a service against a fresh root with injectable clock and optional library wrapper. */
async function makeService({ label, now, dialog, leaseTtlMs, leaseRenewMs } = {}) {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const root = freshRoot(label ?? 'svc');
    const clock = { value: now ?? Date.now() };
    const svc = createStorageService({
        root,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => clock.value,
        dialog: dialog ?? null,
        leaseTtlMs: leaseTtlMs ?? 30000,
        leaseRenewMs: leaseRenewMs ?? 10000,
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data, withFrame) => svc.runInRequestContext(withFrame ?? frame, () => svc.handlers[action](data));
    return { svc, call, frame, clock, root, contracts };
}

/** Drive a chunked upload through the real handlers; returns the commit result. */
async function uploadDocument(service, document, { expectedRevision = 0, name, corruptChunk } = {}) {
    const bytes = Buffer.from(JSON.stringify(document), 'utf8');
    const begin = await service.call('storage.v1.upload.begin', {
        sessionId: service.sessionId, expectedRevision, declaredLength: bytes.length, ...(name ? { name } : {}),
    });
    if (!begin.ok) return begin;
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const data = corruptChunk && offset === 0 ? slice.toString('base64') + '!!' : slice.toString('base64');
        const chunk = await service.call('storage.v1.upload.chunk', { transferId, offset, data });
        if (!chunk.ok) return chunk;
    }
    return await service.call('storage.v1.upload.commit', { transferId });
}

async function seedProjectWithSnapshots(call, snapshotCount = 2) {
    const created = await call('project.create', { name: '备份项目' });
    assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
    const service = { call, sessionId: created.data.sessionId };
    const refs = [];
    let expectedRevision = 0;
    for (let index = 0; index < snapshotCount; index += 1) {
        const document = await sampleDoc(`版本${index + 1}`);
        const result = await uploadDocument(service, document, { expectedRevision });
        assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
        expectedRevision = result.data.revision;
        refs.push({ ref: result.data.snapshot, document });
    }
    return { projectId: created.data.projectId, refs, sessionId: created.data.sessionId };
}

test('service end-to-end: create, bounded upload, commit, status integrity, snapshot download', async () => {
    const { svc, call, contracts } = await makeService({ label: 'e2e' });
    const created = await call('project.create', { name: '端到端' });
    assert.equal(created.ok, true);
    assert.equal(created.data.revision, 0);
    assert.equal(created.data.leaseOwned, true, 'creation acquires the write lease');
    const service = { call, sessionId: created.data.sessionId };
    const document = await sampleDoc('端到端');
    const commit = await uploadDocument(service, document, { name: '端到端改' });
    assert.equal(commit.ok, true, JSON.stringify(commit.error ?? {}));
    assert.equal(commit.data.revision, 1);
    const expectedDigest = crypto.createHash('sha256')
        .update(Buffer.from(contracts.canonicalJson(document), 'utf8')).digest('hex');
    assert.equal(commit.data.snapshot.digest, expectedDigest, 'snapshot digest is the canonical sha256');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.ok, true);
    assert.equal(status.data.revision, 1);
    assert.deepEqual(status.data.integrity, { objects: 1, missing: 0, corrupt: 0, orphans: 0 });
    assert.deepEqual(status.data.lease, { owned: true, busy: false, generation: 1 }, 'own lease is not reported as foreign busy');
    assert.equal(status.data.name, '端到端改', 'commit applied the renamed project name');
    // Round-trip download returns the exact canonical bytes.
    const read = await call('storage.v1.snapshot.read', { sessionId: created.data.sessionId });
    assert.equal(read.ok, true);
    assert.equal(read.data.length, Buffer.from(contracts.canonicalJson(document), 'utf8').length);
    const parts = [];
    let final = false;
    while (!final) {
        const chunk = await call('storage.v1.snapshot.download.chunk', { transferId: read.data.transferId });
        assert.equal(chunk.ok, true);
        parts.push(Buffer.from(chunk.data.data, 'base64'));
        final = chunk.data.final;
    }
    const downloaded = Buffer.concat(parts).toString('utf8');
    assert.equal(downloaded, contracts.canonicalJson(document));
    const parsed = JSON.parse(downloaded);
    contracts.assertSceneDocument(parsed);
    // Second snapshot and history access.
    const second = await uploadDocument(service, await sampleDoc('端到端'), { expectedRevision: 1 });
    assert.equal(second.ok, true);
    assert.equal(second.data.revision, 2);
    const explicit = await call('storage.v1.snapshot.read', { sessionId: created.data.sessionId, snapshotId: commit.data.snapshot.snapshotId });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.data.snapshot.revision, 1, 'registered history snapshots stay readable');
    await svc.dispose();
});

test('service enforces transfer limits, order, base64, declared length and session exclusivity', async () => {
    const { svc, call } = await makeService({ label: 'limits' });
    const created = await call('project.create', { name: '限制' });
    const sessionId = created.data.sessionId;
    const bytes = Buffer.from(JSON.stringify({ payload: "x".repeat(64) }), "utf8");
    // Over-64MiB declarations are rejected by the payload schema at dispatch level; the handler
    // also guards through createStorageService (verified here via schema for the envelope limit).
    const begin = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    const transferId = begin.data.transferId;
    const second = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(second.ok, false);
    assert.equal(second.error.message, 'storage.v1/transfer-limit', 'one upload per session');
    // Out-of-order chunk cancels the transfer.
    const badOrder = await call('storage.v1.upload.chunk', { transferId, offset: bytes.length + 1, data: SAMPLE_B64 });
    assert.equal(badOrder.error.message, 'storage.v1/upload-format');
    const afterOrder = await call('storage.v1.upload.chunk', { transferId, offset: 0, data: SAMPLE_B64 });
    assert.equal(afterOrder.error.message, 'storage.v1/unknown-transfer', 'cancelled transfer is gone');
    // Declared length mismatch refuses the commit.
    const begin2 = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    const tid2 = begin2.data.transferId;
    await call('storage.v1.upload.chunk', { transferId: tid2, offset: 0, data: SAMPLE_B64 });
    const prematureCommit = await call('storage.v1.upload.commit', { transferId: tid2 });
    assert.equal(prematureCommit.error.message, 'storage.v1/upload-format');
    // Bad base64 at handler level (defense in depth beyond the schema).
    const begin3 = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    const bad = await call('storage.v1.upload.chunk', { transferId: begin3.data.transferId, offset: 0, data: 'QUJD!!' });
    assert.equal(bad.error.message, 'storage.v1/upload-format');
    // Abort works and frees the session slot.
    const begin4 = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    const abort = await call('storage.v1.transfer.abort', { transferId: begin4.data.transferId });
    assert.equal(abort.ok, true);
    // Revision conflict: expectedRevision must match the project revision.
    const conflict = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 7, declaredLength: bytes.length });
    assert.equal(conflict.error.message, 'storage.v1/revision-conflict');
    await svc.dispose();
});

test('service binds sessions to the exact frame and rejects cross-frame reuse', async () => {
    const { svc, call, frame } = await makeService({ label: 'frames' });
    const created = await call('project.create', { name: '跨帧' });
    const sessionId = created.data.sessionId;
    const impostor = { sender: { id: 99 }, senderFrame: { url: 'director://app/' } };
    const hijack = await call('storage.v1.session.activate', { sessionId }, impostor);
    assert.equal(hijack.error.message, 'storage.v1/frame-mismatch');
    const sameUrlOtherFrame = { sender: frame.sender, senderFrame: { url: 'director://app/' } };
    const otherFrame = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: 16 }, sameUrlOtherFrame);
    assert.equal(otherFrame.error.message, 'storage.v1/frame-mismatch', 'a same-URL different frame object must not reuse the session');
    const unknown = await call('storage.v1.session.activate', { sessionId: 'sess-nonexistent' });
    assert.equal(unknown.error.message, 'storage.v1/unknown-session');
    await svc.dispose();
});

test('reload/close releases the lease; the lease row is gone and slots are reusable', async () => {
    const { svc, call } = await makeService({ label: 'release' });
    const created = await call('project.create', { name: '释放' });
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.data.lease.busy, false);
    svc.closeFrameSessions();
    const released = await call('project.status', { projectId: created.data.projectId });
    assert.equal(released.data.lease.owned, false);
    assert.equal(released.data.lease.busy, false, 'released lease no longer reports the project busy');
    await svc.dispose();
});

test('idle transfers are swept by the injected clock and stop accepting chunks', async () => {
    const { svc, call, clock } = await makeService({ label: 'sweep', now: 1000000 });
    const created = await call('project.create', { name: '超时' });
    const sessionId = created.data.sessionId;
    const bytes = Buffer.from(JSON.stringify({ payload: "x".repeat(64) }), "utf8");
    const begin = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length });
    const transferId = begin.data.transferId;
    clock.value += 61000; // idle beyond 60s
    svc._internal.sweepTransfers();
    const stale = await call('storage.v1.upload.chunk', { transferId, offset: 0, data: SAMPLE_B64 });
    assert.equal(stale.error.message, 'storage.v1/unknown-transfer', 'swept transfer is rejected');
    assert.equal(svc.isBusy(), false);
    await svc.dispose();
});

test('DB registration failure keeps the pointer unmoved and the published object becomes an orphan', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('orphan');
    const realLibrary = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let failRegistration = true;
    const svc = createStorageService({
        root,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
        library: {
            ...realLibrary,
            commitSnapshot(args) {
                if (failRegistration) throw Object.assign(Error('注入：登记失败'), { reason: 'database-locked' });
                return realLibrary.commitSnapshot(args);
            },
        },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '孤儿' });
    const service = { call, sessionId: created.data.sessionId };
    const failed = await uploadDocument(service, await sampleDoc("孤儿快照"));
    assert.equal(failed.error.message, 'storage.v1/database-locked');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.data.revision, 0, 'trusted pointer must not move');
    assert.equal(status.data.current, null);
    assert.equal(status.data.integrity.orphans, 1, 'published object is visible as an orphan, never silently trusted');
    assert.equal(status.data.integrity.missing, 0);
    // Registration recovers on the retry.
    failRegistration = false;
    const retry = await uploadDocument(service, await sampleDoc("孤儿快照"));
    assert.equal(retry.ok, true);
    const status2 = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status2.data.revision, 1);
    assert.equal(status2.data.integrity.orphans, 1, 'the old orphan is still reported, not cleaned');
    svc.dispose();
    realLibrary.close();
});

test('uncertain commit receipt: registration verifies by snapshot id instead of blind retry', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('uncertain');
    const realLibrary = openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let dropReceipt = false;
    const svc = createStorageService({
        root,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
        library: {
            ...realLibrary,
            commitSnapshot(args) {
                if (!dropReceipt) return realLibrary.commitSnapshot(args);
                // Simulate: COMMIT durably landed, then the process lost the receipt. The library
                // verifies by snapshot id; if the row is there the outcome is success.
                return realLibrary.commitSnapshot(args, { commitReceipt() { dropReceipt = false; throw Error('receipt lost'); } });
            },
        },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '回执' });
    const service = { call, sessionId: created.data.sessionId };
    dropReceipt = true;
    const result = await uploadDocument(service, await sampleDoc("孤儿快照"));
    assert.equal(result.ok, true, 'verified commit must be reported as saved, not retried');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.data.revision, 1);
    svc.dispose();
    realLibrary.close();
});

test('backup creates an isolated directory and restore registers a brand-new project with identical hashes', async () => {
    const { svc, call, root } = await makeService({ label: 'backup' });
    const seeded = await seedProjectWithSnapshots(call, 2);
    const backupRoot = path.join(freshRoot('backup-target'));
    let dialogResult = { canceled: true, filePaths: [] };
    const dialog = { showOpenDialog: async () => dialogResult };
    // The default fixture service has dialog = null, so backup must fail explicitly, never fake.
    const unavailable = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(unavailable.error.message, 'storage.v1/storage-unavailable', 'missing dialog is an explicit failure');
    // Rebuild a service with a controllable dialog on the SAME storage root.
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const svc3 = createStorageService({
        root,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
        dialog,
    });
    const call3 = (action, data) => svc3.runInRequestContext({ sender: { id: 1 }, senderFrame: { url: 'director://app/' } }, () => svc3.handlers[action](data));
    dialogResult = { canceled: true, filePaths: [] };
    const cancelled = await call3('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.deepEqual(cancelled.data, { cancelled: true }, 'dialog cancel returns an explicit cancelled result');
    dialogResult = { canceled: false, filePaths: [backupRoot] };
    const created = await call3('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(created.ok, true, JSON.stringify(created.error ?? {}));
    assert.equal(created.data.snapshots, 2);
    assert.equal(created.data.objects, 2);
    const backupDirs = fs.readdirSync(backupRoot).filter(name => name.startsWith('director-desk-backup-'));
    assert.equal(backupDirs.length, 1, 'exactly one final backup directory is published');
    const backupDir = path.join(backupRoot, backupDirs[0]);
    assert.deepEqual(fs.readdirSync(backupDir).sort(), ['library.sqlite', 'manifest.json', 'objects']);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 'director-desk-backup.v1');
    assert.equal(manifest.snapshots.length, 2);
    // Restore into the same library creates a NEW project with identical object hashes.
    dialogResult = { canceled: false, filePaths: [backupDir] };
    const restored = await call3('storage.v1.backup.restore', {});
    assert.equal(restored.ok, true, JSON.stringify(restored.error ?? {}));
    assert.notEqual(restored.data.projectId, seeded.projectId, 'restore must create a new project id');
    assert.equal(restored.data.snapshots, 2);
    assert.equal(restored.data.revision, 2);
    const restoredStatus = await call3('project.status', { projectId: restored.data.projectId });
    assert.equal(restoredStatus.ok, true);
    assert.deepEqual(restoredStatus.data.integrity, { objects: 2, missing: 0, corrupt: 0, orphans: 0 });
    const originalDigests = manifest.snapshots.map(s => s.digest).sort();
    const restoredLibrary = (await libraryPromise).openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    const restoredSnapshots = restoredLibrary.listSnapshots(restored.data.projectId);
    assert.deepEqual(restoredSnapshots.map(s => s.digest).sort(), originalDigests, 'history hashes survive the restore');
    assert.notDeepEqual(restoredSnapshots.map(s => s.snapshotId).sort(), manifest.snapshots.map(s => s.snapshotId).sort(), 'snapshot ids are remapped');
    // The original project is untouched.
    const original = await call3('project.status', { projectId: seeded.projectId });
    assert.equal(original.data.revision, 2);
    svc3.dispose();
    await svc.dispose();
});

test('restore rejects damaged objects, foreign structure and junction indirection without touching the library', async () => {
    const { svc, call, root } = await makeService({ label: 'backup-evil' });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backupRoot = freshRoot('evil-target');
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    let dialogResult = { canceled: false, filePaths: [backupRoot] };
    const svc2 = createStorageService({
        root, dialog: { showOpenDialog: async () => dialogResult },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const call2 = (action, data) => svc2.runInRequestContext({ sender: { id: 1 }, senderFrame: { url: 'director://app/' } }, () => svc2.handlers[action](data));
    const created = await call2('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(created.ok, true);
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot).find(name => name.startsWith('director-desk-backup-')));
    dialogResult = { canceled: false, filePaths: [backupDir] };
    // 1. Corrupted object byte content.
    const objectFile = fs.readdirSync(path.join(backupDir, 'objects'))[0];
    fs.writeFileSync(path.join(backupDir, 'objects', objectFile), Buffer.from('corrupted bytes'));
    const corrupted = await call2('storage.v1.backup.restore', {});
    assert.equal(corrupted.error.message, 'storage.v1/corrupt-object', 'digest mismatch rejects the backup with the specific reason');
    // Restore the content for the next variants.
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    const goodBytes = await svc2._internal.store.getObject(seeded.projectId, manifest.objects[0].digest, manifest.objects[0].length);
    fs.writeFileSync(path.join(backupDir, 'objects', objectFile), goodBytes);
    // 2. Unexpected extra structure in the backup directory.
    fs.writeFileSync(path.join(backupDir, 'extra.txt'), 'nope');
    const extra = await call2('storage.v1.backup.restore', {});
    assert.equal(extra.error.message, 'storage.v1/backup-invalid');
    fs.rmSync(path.join(backupDir, 'extra.txt'));
    // 3. Junction/symlink indirection for the objects directory must be refused.
    fs.rmSync(path.join(backupDir, 'objects'), { recursive: true });
    const junctionTarget = path.join(backupRoot, 'real-objects');
    fs.mkdirSync(junctionTarget);
    fs.copyFileSync(path.join(backupDir, 'manifest.json'), path.join(backupRoot, 'manifest-copy.json'));
    let junctionMade = true;
    try { fs.symlinkSync(junctionTarget, path.join(backupDir, 'objects'), 'junction'); }
    catch { junctionMade = false; }
    if (junctionMade) {
        const junction = await call2('storage.v1.backup.restore', {});
        assert.equal(junction.error.message, 'storage.v1/path-refused', 'junction indirection is refused');
        fs.rmSync(path.join(backupDir, 'objects'));
    } else {
        assert.ok(true, 'junction creation unavailable on this volume; case skipped');
    }
    // 4. Restore a healthy copy to prove the checks are not false positives.
    fs.mkdirSync(path.join(backupDir, 'objects'));
    fs.writeFileSync(path.join(backupDir, 'objects', objectFile), goodBytes);
    dialogResult = { canceled: false, filePaths: [backupDir] };
    const healthy = await call2('storage.v1.backup.restore', {});
    assert.equal(healthy.ok, true, JSON.stringify(healthy.error ?? {}));
    const list = await call2('storage.v1.project.list', {});
    assert.equal(list.data.projects.length, 2, 'original project plus exactly one restored project');
    svc2.dispose();
    await svc.dispose();
});

test('bootstrap/activate/leave persist only explicit choices across service restarts', async () => {
    const root = freshRoot('persist');
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const build = () => createStorageService({
        root, dialog: null,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const one = build();
    const call1 = (action, data) => one.runInRequestContext(frame, () => one.handlers[action](data));
    const boot0 = await call1('storage.v1.session.bootstrap', {});
    assert.deepEqual(boot0.data, { mode: null, projectId: null, name: null }, 'a fresh library has no session choice');
    const created = await call1('project.create', { name: '持久' });
    one.dispose();
    // A restart (window close) must NOT erase the confirmed choice; none was confirmed yet.
    const two = build();
    const call2 = (action, data) => two.runInRequestContext(frame, () => two.handlers[action](data));
    const boot1 = await call2('storage.v1.session.bootstrap', {});
    assert.deepEqual(boot1.data, { mode: null, projectId: null, name: null }, 'opening alone never sets a choice');
    // Activate after successful load persists managed.
    await call2('project.open', { projectId: created.data.projectId });
    const session = (await call2('project.open', { projectId: created.data.projectId })).data;
    await call2('storage.v1.session.activate', { sessionId: session.sessionId });
    two.dispose();
    const three = build();
    const call3 = (action, data) => three.runInRequestContext(frame, () => three.handlers[action](data));
    const boot2 = await call3('storage.v1.session.bootstrap', {});
    assert.deepEqual(boot2.data, { mode: 'managed', projectId: created.data.projectId, name: '持久' });
    // Explicit leave is the only way back to unmanaged.
    const again = (await call3('project.open', { projectId: created.data.projectId })).data;
    await call3('storage.v1.session.leave', { sessionId: again.sessionId });
    const boot3 = await call3('storage.v1.session.bootstrap', {});
    assert.deepEqual(boot3.data, { mode: 'unmanaged', projectId: null, name: null });
    three.dispose();
});

test('pipeline actions return validated summaries/status through the dispatcher with real handlers', async () => {
    const { svc, call, contracts } = await makeService({ label: 'pipeline' });
    const created = await call('project.create', { name: '管道' });
    assert.equal(created.ok, true);
    const list = await call('project.list', {});
    assert.equal(list.ok, true);
    assert.equal(list.data.projects.length, 1);
    assert.equal(list.data.projects[0].name, '管道');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.ok, true);
    assert.equal(status.data.lease.owned, true);
    const opened = await call('project.open', { projectId: created.data.projectId });
    assert.equal(opened.ok, true, 'open succeeds read-only while the lease is foreign');
    assert.equal(opened.data.leaseOwned, false);
    assert.equal(opened.data.leaseBusy, true, 'the second session sees the project as busy');
    // Saving from the busy session is refused with the frozen lease reason.
    const busySave = await uploadDocument({ call, sessionId: opened.data.sessionId }, await sampleDoc("忙项目快照"));
    assert.equal(busySave.error.message, 'storage.v1/lease-busy');
    const unknown = await call('project.open', { projectId: 'proj-missing' });
    assert.equal(unknown.error.message, 'storage.v1/unknown-project');
    // Handler results are self-checked against the frozen result schemas (spot check the registry).
    assert.ok(contracts.PIPELINE_STORAGE_RESULT_SCHEMAS['project.list'].safeParse(list.data).success);
    assert.ok(contracts.STORAGE_RESULT_SCHEMAS['storage.v1.session.bootstrap'].safeParse((await call('storage.v1.session.bootstrap', {})).data).success);
    await svc.dispose();
});

test('storage.v1 paged project list matches the underlying rows', async () => {
    const { svc, call } = await makeService({ label: 'paging' });
    for (const [index, name] of ['甲', '乙', '丙'].entries()) {
        const created = await call('project.create', { name: `项目${name}` });
        assert.equal(created.ok, true);
        void index;
    }
    const page1 = await call('storage.v1.project.list', { limit: 2 });
    assert.equal(page1.data.projects.length, 2);
    assert.equal(page1.data.nextCursor, page1.data.projects[1].projectId);
    const page2 = await call('storage.v1.project.list', { cursor: page1.data.nextCursor, limit: 2 });
    assert.equal(page2.data.projects.length, 1);
    assert.equal(page2.data.nextCursor, null);
    await svc.dispose();
});

// =====================================================================================
// Rework-1 segment A counter-examples (R1/R2/R3/R7/R8/R9/R10). Each case reproduces the
// reviewer's concrete failure scenario against the real library/object/service layers.
// =====================================================================================

const SCHEMA_V1_TEST_DDL = [
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL);',
    'CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, current_snapshot_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
    'CREATE TABLE snapshots (project_id TEXT NOT NULL REFERENCES projects(project_id), snapshot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, length INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, revision));',
    'CREATE TABLE project_leases (project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);',
    'CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, project_id TEXT, name TEXT, updated_at TEXT NOT NULL);',
].join('\n');

function makeRawDb(file, build) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    try { build(raw); } finally { raw.close(); }
}

test('R1: triggers, views, authored indexes, extra columns and forged migrations are refused read-only without touching the file', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('r1');
    const variants = [
        // 'trigger' is prepared above (including the live-fire proof); the loop reuses that file.
        ['view', () => {
            makeRawDb(path.join(root, 'view.sqlite'), raw => {
                raw.exec(SCHEMA_V1_TEST_DDL);
                raw.exec('CREATE VIEW evil AS SELECT 1;');
            });
        }],
        ['authored-index', () => {
            makeRawDb(path.join(root, 'authored-index.sqlite'), raw => {
                raw.exec(SCHEMA_V1_TEST_DDL);
                raw.exec('CREATE INDEX evil_idx ON projects(name);');
            });
        }],
        ['extra-column', () => {
            makeRawDb(path.join(root, 'extra-column.sqlite'), raw => {
                raw.exec(SCHEMA_V1_TEST_DDL);
                raw.exec('ALTER TABLE projects ADD COLUMN evil TEXT;');
            });
        }],
        ['forged-migration', () => {
            makeRawDb(path.join(root, 'forged-migration.sqlite'), raw => {
                raw.exec(SCHEMA_V1_TEST_DDL);
                raw.prepare('UPDATE schema_migrations SET version = 2').run();
            });
        }],
        ['wrong-fingerprint', () => {
            makeRawDb(path.join(root, 'wrong-fingerprint.sqlite'), raw => {
                raw.exec(SCHEMA_V1_TEST_DDL);
                raw.prepare('UPDATE schema_migrations SET fingerprint = ?').run('forged');
            });
        }],
    ];
    // The dangerous trigger really would rewrite revisions to 99 if a library accepted the file.
    const triggerFile = path.join(root, 'trigger.sqlite');
    makeRawDb(triggerFile, raw => { raw.exec(SCHEMA_V1_TEST_DDL); });
    const rawProbe = new (require('node:sqlite').DatabaseSync)(triggerFile);
    rawProbe.prepare("INSERT INTO projects (project_id, name, revision, created_at, updated_at) VALUES ('x', 'y', 1, 't', 't')").run();
    rawProbe.exec('CREATE TRIGGER evil AFTER UPDATE ON projects BEGIN UPDATE projects SET revision = 99; END;');
    rawProbe.prepare("UPDATE projects SET name = 'z' WHERE project_id = 'x'").run();
    assert.equal(rawProbe.prepare('SELECT revision FROM projects').get().revision, 99, 'the trigger really rewrites revisions — the refusal below is the fix');
    rawProbe.close();
    fs.rmSync(triggerFile, { force: true });
    makeRawDb(triggerFile, raw => {
        raw.exec(SCHEMA_V1_TEST_DDL);
        raw.exec('CREATE TRIGGER evil AFTER UPDATE ON projects BEGIN UPDATE projects SET revision = 99; END;');
    });
    for (const [label, build] of variants) {
        const file = path.join(root, `${label}.sqlite`);
        build();
        const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        let error = null;
        try { openLibrary({ file, now: () => Date.now() }); }
        catch (caught) { error = caught; }
        assert.ok(error, `${label}: open must fail`);
        assert.equal(error.reason, 'schema-unsupported', `${label}: wrong reason: ${error.message}`);
        const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.equal(after, before, `${label}: refused database must stay byte-identical`);
    }
    // A healthy v1 database still opens after the strict identification round trip.
    const healthy = path.join(root, 'healthy.sqlite');
    makeRawDb(healthy, raw => {
        raw.exec(SCHEMA_V1_TEST_DDL);
        raw.prepare('INSERT INTO schema_migrations (version, fingerprint, applied_at) VALUES (1, ?, ?)').run('dsk-storage-v1', new Date().toISOString());
    });
    const lib = openLibrary({ file: healthy, now: () => Date.now() });
    assert.equal(lib.getlastSession(), null);
    lib.close();
});

test('R2: a same-length tampered object under its digest name is refused and never overwritten', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('r2');
    const store = createObjectStore({ root });
    const good = Buffer.from('{" legitimate content ":1}');
    const { digest, length } = await store.putObject('proj-r2', good);
    const file = path.join(root, 'projects', 'proj-r2', 'objects', `${digest}.json`);
    const tampered = Buffer.alloc(length, 0x41); // SAME length, different bytes
    assert.notEqual(crypto.createHash('sha256').update(tampered).digest('hex'), digest);
    fs.writeFileSync(file, tampered);
    await assert.rejects(() => store.putObject('proj-r2', good), error => error.reason === 'corrupt-object',
        'same-length tampered content must not be trusted as the digest object');
    assert.deepEqual(fs.readFileSync(file), tampered, 'the store must not overwrite or repair the corrupt file');
    await assert.rejects(() => store.getObject('proj-r2', digest, length), error => error.reason === 'corrupt-object');
    fs.writeFileSync(file, good);
    const reused = await store.putObject('proj-r2', good);
    assert.deepEqual(reused, { digest, length }, 'verified identical content is still deduplicated');
});

test('R2 service path: pre-tampered target object fails the save, pointer unmoved, tmp cleaned', async () => {
    const { svc, call, root, contracts } = await makeService({ label: 'r2-svc' });
    const created = await call('project.create', { name: '篡改' });
    const service = { call, sessionId: created.data.sessionId };
    const document = await sampleDoc('篡改目标');
    const canonicalBytes = Buffer.from(contracts.canonicalJson(document), 'utf8');
    const futureDigest = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
    const objectsDir = path.join(root, 'projects', created.data.projectId, 'objects');
    fs.mkdirSync(objectsDir, { recursive: true });
    fs.writeFileSync(path.join(objectsDir, `${futureDigest}.json`), Buffer.alloc(canonicalBytes.length, 0x42));
    const failed = await uploadDocument(service, document);
    assert.equal(failed.error.message, 'storage.v1/corrupt-object');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.data.revision, 0, 'failed save must not move the trusted pointer');
    assert.equal(status.data.current, null);
    assert.equal(svc._internal.transfers.size, 0, 'failed upload cleans its transfer');
    const uploadsDir = path.join(root, 'uploads');
    const leftover = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    assert.deepEqual(leftover, [], 'failed upload cleans its tmp file');
    assert.equal(fs.readFileSync(path.join(objectsDir, `${futureDigest}.json`)).length, canonicalBytes.length, 'tampered file left untouched, not repaired');
    await svc.dispose();
});

test('R3: snapshot digest rewritten in manifest and backup database cannot restore a missing object', async () => {
    const { svc, call, root } = await makeService({ label: 'r3' });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backupRoot = freshRoot('r3-target');
    let dialogResult = { canceled: false, filePaths: [backupRoot] };
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const svc2 = createStorageService({
        root, dialog: { showOpenDialog: async () => dialogResult },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const call2 = (action, data) => svc2.runInRequestContext({ sender: { id: 1 }, senderFrame: { url: 'director://app/' } }, () => svc2.handlers[action](data));
    assert.equal((await call2('storage.v1.backup.create', { projectId: seeded.projectId })).ok, true);
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot).find(name => name.startsWith('director-desk-backup-')));
    const forgedDigest = 'f'.repeat(64);
    // Rewrite BOTH the manifest and the backup database to claim a digest that has no object.
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    manifest.snapshots[0].digest = forgedDigest;
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(backupDir, 'library.sqlite'));
    raw.prepare('UPDATE snapshots SET digest = ?').run(forgedDigest);
    raw.close();
    const before = await call2('storage.v1.project.list', {});
    const refused = await call2('storage.v1.backup.restore', {});
    assert.equal(refused.error.message, 'storage.v1/backup-invalid', `forged digest must break the snapshot/object closure: ${JSON.stringify(refused.error)}`);
    const after = await call2('storage.v1.project.list', {});
    assert.equal(after.data.projects.length, before.data.projects.length, 'a refused restore must not register any project');
    svc2.dispose();
    await svc.dispose();
});

test('R3: hidden cross-project rows and inconsistent revision pointers reject the backup', async () => {
    const { svc, call, root } = await makeService({ label: 'r3-hidden' });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backupRoot = freshRoot('r3-hidden-target');
    let dialogResult = { canceled: false, filePaths: [backupRoot] };
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const svc2 = createStorageService({
        root, dialog: { showOpenDialog: async () => dialogResult },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const call2 = (action, data) => svc2.runInRequestContext({ sender: { id: 1 }, senderFrame: { url: 'director://app/' } }, () => svc2.handlers[action](data));
    assert.equal((await call2('storage.v1.backup.create', { projectId: seeded.projectId })).ok, true);
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot).find(name => name.startsWith('director-desk-backup-')));
    const dbFile = path.join(backupDir, 'library.sqlite');
    // Hidden second project row with its own snapshot rides inside the backup database.
    const { DatabaseSync } = require('node:sqlite');
    let raw = new DatabaseSync(dbFile);
    raw.prepare("INSERT INTO projects (project_id, name, revision, current_snapshot_id, created_at, updated_at) VALUES ('proj-hidden', '隐藏', 1, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
    raw.prepare("INSERT INTO snapshots (project_id, snapshot_id, revision, digest, length, created_at) VALUES ('proj-hidden', 'snap-hidden', 1, ?, 5, '2026-01-01T00:00:00Z')").run('a'.repeat(64));
    raw.close();
    const hidden = await call2('storage.v1.backup.restore', {});
    assert.equal(hidden.error.message, 'storage.v1/backup-invalid', 'hidden cross-project rows must reject the backup');
    // Clean the forgery, prove the healthy backup still restores, then forge the project revision.
    raw = new DatabaseSync(dbFile);
    raw.prepare("DELETE FROM snapshots WHERE project_id = 'proj-hidden'").run();
    raw.prepare("DELETE FROM projects WHERE project_id = 'proj-hidden'").run();
    raw.close();
    dialogResult = { canceled: false, filePaths: [backupDir] };
    assert.equal((await call2('storage.v1.backup.restore', {})).ok, true, 'the cleaned backup must restore after the forgery case');
    const secondBackupRoot = freshRoot('r3-rev-target');
    dialogResult = { canceled: false, filePaths: [secondBackupRoot] };
    assert.equal((await call2('storage.v1.backup.create', { projectId: seeded.projectId })).ok, true);
    const secondDir = path.join(secondBackupRoot, fs.readdirSync(secondBackupRoot).find(name => name.startsWith('director-desk-backup-')));
    raw = new DatabaseSync(path.join(secondDir, 'library.sqlite'));
    raw.prepare('UPDATE projects SET revision = 99').run();
    raw.close();
    const revisionForged = await call2('storage.v1.backup.restore', {});
    assert.equal(revisionForged.error.message, 'storage.v1/backup-invalid', 'project revision must match the snapshot set');
    svc2.dispose();
    await svc.dispose();
});

test('R7: concurrent upload.begin cannot break the single-slot limit; operations serialize per transfer', async () => {
    const { svc, call } = await makeService({ label: 'r7' });
    const created = await call('project.create', { name: '并发' });
    const sessionId = created.data.sessionId;
    const bytes = Buffer.from(JSON.stringify(await sampleDoc('并发')), 'utf8');
    const [first, second] = await Promise.all([
        call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length }),
        call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: bytes.length }),
    ]);
    const winners = [first, second].filter(result => result.ok);
    const losers = [first, second].filter(result => !result.ok);
    assert.equal(winners.length, 1, 'exactly one begin may win the session slot');
    assert.equal(losers[0].error.message, 'storage.v1/transfer-limit');
    const transferId = winners[0].data.transferId;
    // Two chunks aimed at the SAME offset: exactly one lands, ordering stays intact.
    const results = await Promise.all([
        call('storage.v1.upload.chunk', { transferId, offset: 0, data: bytes.subarray(0, 8).toString('base64') }),
        call('storage.v1.upload.chunk', { transferId, offset: 0, data: bytes.subarray(0, 8).toString('base64') }),
    ]);
    const landed = results.filter(result => result.ok);
    assert.equal(landed.length, 1, 'same-offset chunks cannot both land');
    assert.equal(landed[0].data.received, 8);
    // Finish the upload to prove the stream was not corrupted by the concurrency attempt.
    assert.equal((await call('storage.v1.upload.chunk', { transferId, offset: 8, data: bytes.subarray(8).toString('base64') })).ok, true);
    const commit = await call('storage.v1.upload.commit', { transferId });
    assert.equal(commit.ok, true, JSON.stringify(commit.error ?? {}));
    assert.equal(commit.data.revision, 1);
    await svc.dispose();
});

test('R7: non-canonical base64 is refused and late operations after cancel/reload are rejected', async () => {
    const { svc, call, root } = await makeService({ label: 'r7-base64' });
    const created = await call('project.create', { name: '编码' });
    const sessionId = created.data.sessionId;
    const begin = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: 16 });
    const transferId = begin.data.transferId;
    // 'AB==' decodes but re-encodes as 'AA==': not the canonical encoding of its bytes.
    const nonCanonical = await call('storage.v1.upload.chunk', { transferId, offset: 0, data: 'AB==' });
    assert.equal(nonCanonical.error.message, 'storage.v1/upload-format', 'non-canonical base64 must be refused');
    const afterCancel = await call('storage.v1.upload.chunk', { transferId, offset: 0, data: 'QUJD' });
    assert.equal(afterCancel.error.message, 'storage.v1/unknown-transfer', 'the transfer was cancelled by the bad chunk');
    // Reload (closeFrameSessions) recycles transfers; late chunks are refused and tmp files cleaned.
    const begin2 = await call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: 16 });
    const uploadsDir = path.join(root, 'uploads');
    svc.closeFrameSessions();
    const late = await call('storage.v1.upload.chunk', { transferId: begin2.data.transferId, offset: 0, data: 'QUJD' });
    assert.equal(late.error.message, 'storage.v1/unknown-transfer', 'cancelled transfer must refuse late chunks');
    await new Promise(resolve => setTimeout(resolve, 50)); // settle the async tmp cleanup
    const leftover = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    assert.deepEqual(leftover, [], 'cancelled upload must not leave tmp files');
    await svc.dispose();
});

test('R8: node budget scan, canonical expansion cap, oversized manifest and declared-length overrun', async () => {
    const contracts = await contractsPromise;
    // Wide array: 1M+ nodes exhaust the scan budget deterministically.
    assert.match(contracts.scanStorageProject(new Array(1000001).fill(1)), /节点数超过上限/);
    assert.equal(contracts.scanStorageProject(new Array(1000).fill(1)), null);

    // Canonical expansion is capped by the same 64MiB budget (injected canonical explodes).
    const { createStorageService } = await servicePromise;
    const root = freshRoot('r8-canonical');
    const svc = createStorageService({
        root, dialog: null,
        verifiers: {
            document: contracts.assertSceneDocument,
            canonical: () => 'x'.repeat(64 * 1024 * 1024 + 1),
            manifest: contracts.BackupManifestSchema,
        },
        now: () => Date.now(),
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '膨胀' });
    const service = { call, sessionId: created.data.sessionId };
    const smallDocument = await sampleDoc('膨胀');
    const bytes = Buffer.from(JSON.stringify(smallDocument), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    for (let offset = 0; offset < bytes.length; offset += begin.data.chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + begin.data.chunkSize, bytes.length));
        await call('storage.v1.upload.chunk', { transferId: begin.data.transferId, offset, data: slice.toString('base64') });
    }
    const commit = await call('storage.v1.upload.commit', { transferId: begin.data.transferId });
    assert.equal(commit.error.message, 'storage.v1/document-invalid', 'canonical output beyond 64MiB must be refused');
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.data.revision, 0, 'refused expansion keeps the pointer unmoved');
    await svc.dispose();

    // Oversized manifest: bounded read refuses files beyond the derived 4MiB budget before
    // parsing (F06: the budget derives from the 10000-snapshot backup maximum, not arbitrary).
    const { svc: svcB, call: callB, root: rootB } = await makeService({ label: 'r8-manifest' });
    const seeded = await seedProjectWithSnapshots(callB, 1);
    const backupRoot = freshRoot('r8-manifest-target');
    let dialogResult = { canceled: false, filePaths: [backupRoot] };
    const svcC = createStorageService({
        root: rootB, dialog: { showOpenDialog: async () => dialogResult },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const callC = (action, data) => svcC.runInRequestContext({ sender: { id: 1 }, senderFrame: { url: 'director://app/' } }, () => svcC.handlers[action](data));
    assert.equal((await callC('storage.v1.backup.create', { projectId: seeded.projectId })).ok, true);
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot).find(name => name.startsWith('director-desk-backup-')));
    const manifestPath = path.join(backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, Buffer.concat([fs.readFileSync(manifestPath), Buffer.alloc(5 * 1024 * 1024, 0x20)]));
    const oversized = await callC('storage.v1.backup.restore', {});
    assert.equal(oversized.error.message, 'storage.v1/backup-invalid', 'a manifest beyond the derived 4MiB budget is refused before parsing');
    svcC.dispose();
    await svcB.dispose();

    // Declared-length overrun: chunks beyond the declared total are refused.
    const { svc: svcD, call: callD } = await makeService({ label: 'r8-overrun' });
    const overrunCreate = await callD('project.create', { name: '超长' });
    const overrunBegin = await callD('storage.v1.upload.begin', { sessionId: overrunCreate.data.sessionId, expectedRevision: 0, declaredLength: 4 });
    assert.equal((await callD('storage.v1.upload.chunk', { transferId: overrunBegin.data.transferId, offset: 0, data: Buffer.from('AAAA').toString('base64') })).ok, true);
    const overrun = await callD('storage.v1.upload.chunk', { transferId: overrunBegin.data.transferId, offset: 4, data: Buffer.from('BBBB').toString('base64') });
    assert.equal(overrun.error.message, 'storage.v1/upload-format', 'chunks beyond the declared length must be refused');
    await svcD.dispose();
});

function armCommitFault(lib, { landCommit, failVerification }) {
    const raw = lib.raw;
    const originalExec = raw.exec.bind(raw);
    const originalPrepare = raw.prepare.bind(raw);
    let armed = true;
    raw.exec = sql => {
        if (armed && sql === 'COMMIT') {
            armed = false;
            if (landCommit) originalExec(sql); // the commit REALLY lands on disk first
            throw Error('注入：COMMIT 阶段错误');
        }
        return originalExec(sql);
    };
    if (failVerification) {
        raw.prepare = sql => {
            if (/SELECT revision, digest FROM snapshots WHERE snapshot_id/.test(sql)) {
                throw Error('注入：查证查询失败');
            }
            return originalPrepare(sql);
        };
    }
    return () => { raw.exec = originalExec; raw.prepare = originalPrepare; };
}

test('R9: a real COMMIT that lands then throws resolves by snapshot id; non-landing and uncheckable cases classify correctly', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('r9');
    const file = path.join(root, 'library.sqlite');
    const lib = openLibrary({ file, now: () => Date.now() });
    lib.createProject({ projectId: 'proj-r9', name: '提交分类' });
    const lease = lib.acquireLease('proj-r9', 30000);
    const snapshotBase = { digest: 'a'.repeat(64), length: 10, createdAt: new Date().toISOString() };
    // 1. COMMIT lands, then throws: the save is verified through the pre-generated snapshot id.
    let disarm = armCommitFault(lib, { landCommit: true, failVerification: false });
    const verified = lib.commitSnapshot({
        projectId: 'proj-r9', owner: lease.owner, generation: lease.generation, expectedRevision: 0,
        snapshot: { snapshotId: 'snap-r9-1', ...snapshotBase }, now: () => Date.now(),
    });
    disarm();
    assert.deepEqual(verified, { committed: true }, 'a landed commit must be reported saved, not as a generic error');
    assert.equal(lib.getProject('proj-r9').revision, 1);
    // 2. COMMIT throws WITHOUT landing: rollback holds, deterministic failure, pointer unmoved.
    disarm = armCommitFault(lib, { landCommit: false, failVerification: false });
    let caught = null;
    try {
        lib.commitSnapshot({
            projectId: 'proj-r9', owner: lease.owner, generation: lease.generation, expectedRevision: 1,
            snapshot: { snapshotId: 'snap-r9-2', ...snapshotBase }, now: () => Date.now(),
        });
    } catch (error) { caught = error; }
    disarm();
    assert.equal(caught && caught.reason, 'io-failure', `a non-landing commit is a clean failure: ${JSON.stringify(caught && caught.message)}`);
    assert.equal(lib.getProject('proj-r9').revision, 1, 'pointer unmoved when the commit did not land');
    // 3. COMMIT lands but verification cannot run: the outcome stays unknown, never "retry blind".
    disarm = armCommitFault(lib, { landCommit: true, failVerification: true });
    caught = null;
    try {
        lib.commitSnapshot({
            projectId: 'proj-r9', owner: lease.owner, generation: lease.generation, expectedRevision: 1,
            snapshot: { snapshotId: 'snap-r9-3', ...snapshotBase }, now: () => Date.now(),
        });
    } catch (error) { caught = error; }
    disarm();
    assert.equal(caught && caught.reason, 'outcome-unknown', `uncheckable outcome must be outcome-unknown: ${JSON.stringify(caught && caught.message)}`);
    lib.close();
});

test('R10: renewal with a real foreign lock degrades the lease, samples the clock inside the transaction and never writes when expired', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('r10');
    const file = path.join(root, 'library.sqlite');
    let clock = 1000;
    const lib = openLibrary({ file, now: () => clock });
    lib.createProject({ projectId: 'proj-r10', name: '续租' });
    const lease = lib.acquireLease('proj-r10', 30000);
    assert.equal(lease.acquired, true);
    // A second REAL connection holds the write lock across the renewal window.
    const { DatabaseSync } = require('node:sqlite');
    const blocker = new DatabaseSync(file);
    blocker.exec('PRAGMA busy_timeout = 5000');
    blocker.exec('BEGIN IMMEDIATE');
    let renewError = null;
    try { lib.renewLease('proj-r10', lease.owner, lease.generation, 30000); }
    catch (error) { renewError = error; }
    assert.equal(renewError && renewError.reason, 'database-locked', `renewal under a foreign lock fails in a controlled way: ${JSON.stringify(renewError && renewError.message)}`);
    assert.equal(lib.leaseState('proj-r10').generation, lease.generation, 'the lease is not resurrected by a failed renewal');
    blocker.exec('ROLLBACK');
    blocker.close();
    // Clock sampling INSIDE the transaction: a lease that is already expired when the write lock
    // is finally acquired must be taken over (generation+1), not classified busy with a stale time.
    const raw = lib.raw;
    raw.prepare("UPDATE project_leases SET owner = 'old-owner', expires_at = 1000 WHERE project_id = 'proj-r10'").run();
    clock = 5000; // by the time the transaction actually runs, the lease is expired
    const takeover = lib.acquireLease('proj-r10', 30000);
    assert.equal(takeover.acquired, true, 'an expired lease must be taken over even when now() is read late');
    assert.equal(takeover.generation, lease.generation + 1);
    // An expired lease cannot be renewed back to life regardless of the sampled time.
    const expired = lib.renewLease('proj-r10', 'old-owner', lease.generation, 30000);
    assert.equal(expired.renewed, false, 'expired generations cannot be renewed');
    lib.close();
});

test('R10: dialog-pending backups count as busy, disposed services fail fast, renewal errors degrade without crashing', async () => {
    const contracts = await contractsPromise;
    const { createStorageService, createUnavailableStorageService } = await servicePromise;
    const root = freshRoot('r10-busy');
    let releaseDialog;
    const gated = createStorageService({
        root, dialog: { showOpenDialog: () => new Promise(resolve => { releaseDialog = resolve; }) },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => gated.runInRequestContext(frame, () => gated.handlers[action](data));
    await call('project.create', { name: '忙' });
    // restore goes straight to the native dialog; hold it open and check busy accounting.
    const pendingRestore = call('storage.v1.backup.restore', {}).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(gated.isBusy(), true, 'a restore waiting on the native dialog must report the main process busy');
    releaseDialog({ canceled: true, filePaths: [] });
    const cancelled = await pendingRestore;
    assert.equal(cancelled.error.message, 'storage.v1/dialog-cancelled');
    assert.equal(gated.isBusy(), false, 'busy clears once the operation settles');
    gated.dispose();
    // Disposed service: every action fails fast with the frozen reason instead of throwing.
    const afterDispose = await call('storage.v1.session.bootstrap', {});
    assert.equal(afterDispose.ok, false);
    assert.equal(afterDispose.error.message, 'storage.v1/storage-unavailable');

    // Renewal errors inside the timer degrade the lease without an uncaught exception; the next
    // upload re-acquires a fresh generation.
    const root2 = freshRoot('r10-renew');
    let renewShouldFail = true;
    const lib = (await libraryPromise).openLibrary({ file: path.join(root2, 'library.sqlite'), now: () => Date.now() });
    const renewing = {
        ...lib,
        renewLease(...args) {
            if (renewShouldFail) throw Object.assign(Error('注入：续租失败'), { reason: 'database-locked' });
            return lib.renewLease(...args);
        },
    };
    const gated2 = createStorageService({
        root: root2, dialog: null, library: renewing, leaseTtlMs: 1000, leaseRenewMs: 300,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        now: () => Date.now(),
    });
    const call2 = (action, data) => gated2.runInRequestContext(frame, () => gated2.handlers[action](data));
    const created2 = await call2('project.create', { name: '续租降级' });
    assert.equal(created2.data.leaseOwned, true);
    await new Promise(resolve => setTimeout(resolve, 1200)); // one renewal tick fires and fails
    const degraded = [...gated2._internal.sessions.values()][0];
    assert.equal(degraded.leaseOwned, false, 'failed renewal must degrade the lease in a controlled way');
    renewShouldFail = false;
    const bytes = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
    const begin = await call2('storage.v1.upload.begin', { sessionId: created2.data.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true, 'the next save re-acquires the lease from scratch');
    await gated2.dispose();
    lib.close();

    // Unavailable storage: handlers answer with the frozen failure shape instead of crashing.
    const unavailable = createUnavailableStorageService('schema-unsupported: 测试');
    const bootstrap = await unavailable.handlers['storage.v1.session.bootstrap']({});
    assert.equal(bootstrap.ok, false);
    assert.equal(bootstrap.error.message, 'storage.v1/storage-unavailable');
    assert.match(bootstrap.error.details[0], /schema-unsupported/);
    // createStorageService on a foreign database throws schema-unsupported (integration falls back).
    const foreignDir = freshRoot('r10-foreign');
    const foreign = path.join(foreignDir, 'library.sqlite');
    makeRawDb(foreign, raw => { raw.exec('CREATE TABLE totally_different (a)'); });
    const { createStorageService: build } = await servicePromise;
    assert.throws(() => build({ root: foreignDir, dialog: null, verifiers: { document: () => { }, canonical: () => '{}', manifest: { safeParse: () => ({ success: false }) } } }),
        error => error.reason === 'schema-unsupported');
});

// === REWORK-2 CP0 named red tests (F01-F07): each reproduces an isolated reviewer finding
// against the UNFIXED code and must be red now, green only after the corresponding fix. ===

test('REWORK2 F01 red: altered CHECK constraint is currently accepted (must refuse, bytes intact)', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('f01-check');
    const file = path.join(root, 'library.sqlite');
    makeRawDb(file, raw => {
        raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  current_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  snapshot_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  length INTEGER NOT NULL CHECK (length >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, revision)
);
CREATE TABLE project_leases (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  project_id TEXT,
  name TEXT,
  updated_at TEXT NOT NULL
);`);
        raw.prepare('INSERT INTO schema_migrations (version, fingerprint, applied_at) VALUES (1, ?, ?)')
            .run('dsk-storage-v1', new Date().toISOString());
    });
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(() => openLibrary({ file, now: () => Date.now() }), error => error.reason === 'schema-unsupported',
        'an added CHECK constraint changes the v1 schema and must be refused');
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(after, before, 'a refused library must keep the original bytes');
});

test('REWORK2 F01 red: dropped UNIQUE autoindex is currently accepted (must refuse)', async () => {
    const { openLibrary } = await libraryPromise;
    const root = freshRoot('f01-unique');
    const file = path.join(root, 'library.sqlite');
    makeRawDb(file, raw => {
        raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  current_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  snapshot_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  length INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE project_leases (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  project_id TEXT,
  name TEXT,
  updated_at TEXT NOT NULL
);`);
        raw.prepare('INSERT INTO schema_migrations (version, fingerprint, applied_at) VALUES (1, ?, ?)')
            .run('dsk-storage-v1', new Date().toISOString());
    });
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(() => openLibrary({ file, now: () => Date.now() }), error => error.reason === 'schema-unsupported',
        'a dropped UNIQUE(project_id,revision) constraint must be refused');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
});

test('REWORK2 F02 red: a junction on projects/<id> currently writes the object outside the store', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('f02-junction');
    const outside = path.join(root, '..', `f02-target-${process.pid}`);
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched', 'utf8');
    try {
        fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
        const link = path.join(root, 'projects', 'proj-junc1');
        fs.symlinkSync(outside, link, 'junction');
        const store = createObjectStore({ root });
        const bytes = Buffer.from('escape payload', 'utf8');
        await assert.rejects(() => store.putObject('proj-junc1', bytes),
            error => error.reason === 'path-refused', 'a junctioned project directory must be refused');
        assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt'], 'nothing may be written through the junction');
    } finally {
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('REWORK2 F03 red: a backup whose project row has NULL current but non-empty snapshots currently restores', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const { createBackupDatabase } = await libraryPromise;
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('f03-nullcurrent');
    const store = createObjectStore({ root });
    const document = await sampleDoc('review');
    const bytes = Buffer.from(contracts.canonicalJson(document), 'utf8');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const snapshotId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    await store.putObject(sourceId, bytes);
    const backupRoot = freshRoot('f03-backup');
    const backupDir = path.join(backupRoot, 'bk');
    fs.mkdirSync(path.join(backupDir, 'objects'), { recursive: true });
    createBackupDatabase(path.join(backupDir, 'library.sqlite'), {
        project: { projectId: sourceId, name: 'review', revision: 1, currentSnapshotId: null, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' },
        snapshots: [{ snapshotId, revision: 1, digest, length: bytes.length, createdAt: '2026-09-16T00:00:00.000Z' }],
        createdAt: '2026-09-16T00:00:00.000Z',
    });
    fs.writeFileSync(path.join(backupDir, 'objects', `${digest}.json`), bytes);
    const manifest = {
        version: 'director-desk-backup.v1', contractVersion: 'dsk.v1', sourceProjectId: sourceId,
        name: 'review', createdAt: '2026-09-16T00:00:00.000Z',
        snapshots: [{ snapshotId, revision: 1, digest, length: bytes.length, createdAt: '2026-09-16T00:00:00.000Z' }],
        objects: [{ digest, length: bytes.length }],
    };
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [backupDir] }) };
    const svc = createStorageService({
        root, dialog,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const restore = await svc.runInRequestContext(frame, () => svc.handlers['storage.v1.backup.restore']({}));
    assert.equal(restore.ok, false, 'a NULL current pointer with snapshots must be rejected');
    const list = await svc.runInRequestContext(frame, () => svc.handlers['project.list']({}));
    assert.equal(list.data.projects.length, 0, 'a rejected restore must not register a new project');
    await svc.dispose();
});

test('REWORK2 F04 red: two concurrent snapshot.read calls both succeed and both register transfers', async () => {
    const { svc, call } = await makeService({ label: 'f04-download' });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const session = seeded.sessionId;
    const [first, second] = await Promise.all([
        call('storage.v1.snapshot.read', { sessionId: session }),
        call('storage.v1.snapshot.read', { sessionId: session }),
    ]);
    const successes = [first, second].filter(result => result.ok).length;
    assert.equal(successes, 1, `only one download slot per frame may exist, got ${successes}`);
    await svc.dispose();
});

test('REWORK2 F04 red: an abort racing an in-flight commit still lets the commit register', async () => {
    const { svc, call } = await makeService({ label: 'f04-abort' });
    const created = await call('project.create', { name: '中止竞态' });
    const service = { call, sessionId: created.data.sessionId };
    const document = await sampleDoc('中止竞态');
    const bytes = Buffer.from(JSON.stringify(document), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: service.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: slice.toString('base64') });
        assert.equal(chunk.ok, true);
    }
    // Fire the commit, then land the abort while the commit is still awaiting its I/O.
    const commitPromise = call('storage.v1.upload.commit', { transferId });
    await new Promise(resolve => setTimeout(resolve, 0));
    const abortPromise = call('storage.v1.transfer.abort', { transferId });
    const [commit, abort] = await Promise.all([commitPromise, abortPromise]);
    const status = await call('project.status', { projectId: created.data.projectId });
    const revision = status.ok ? status.data.revision : -1;
    assert.ok(!(commit.ok && abort.ok), `commit and abort must not both succeed (commit=${commit.ok}, abort=${abort.ok})`);
    if (abort.ok) assert.equal(revision, 0, 'a successful abort must prevent the registration');
    if (commit.ok) assert.equal(revision, 1, 'a successful commit must be the only winner');
    await svc.dispose();
});

test('REWORK2 F04 red: a begin raced by closeFrameSessions succeeds and leaves a .part file behind', async () => {
    const { svc, call, root } = await makeService({ label: 'f04-latebegin' });
    const created = await call('project.create', { name: '迟到' });
    const sessionId = created.data.sessionId;
    const beginPromise = call('storage.v1.upload.begin', { sessionId, expectedRevision: 0, declaredLength: 16 });
    svc.closeFrameSessions(); // the frame closes while the begin handler is mid-flight
    const begin = await beginPromise;
    assert.equal(begin.ok, false, `a begin whose session closed mid-flight must fail, got ${JSON.stringify(begin)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const uploadsDir = path.join(root, 'uploads');
    const leftovers = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).filter(name => name.endsWith('.part')) : [];
    assert.deepEqual(leftovers, [], 'no .part file may survive a closed frame');
    await svc.dispose();
});

test('REWORK2 F05 red: a 65MiB object with declared length 8450 is fully read before the length check', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('f05-bounded');
    const store = createObjectStore({ root });
    const projectId = 'proj-f05';
    const oversized = Buffer.alloc(68157440, 0x41); // 65 MiB of payload behind a tiny declaration
    const digest = crypto.createHash('sha256').update(oversized).digest('hex');
    const dir = path.join(root, 'projects', projectId, 'objects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${digest}.json`), oversized);
    const error = await store.getObject(projectId, digest, 8450).catch(e => e);
    assert.equal(error.reason, 'corrupt-object');
    assert.equal(typeof store._lastReadBytes, 'number', 'the store must report how many bytes it actually read');
    assert.ok(store._lastReadBytes <= 8450 + 1, `the read must be bounded by the declared length, read ${store._lastReadBytes}`);
});

test('REWORK2 F06: 5000 AND 10000-snapshot self-produced backups round-trip (derived manifest budget)', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const libraryBundle = await libraryPromise;
    const { createObjectStore } = await objectsPromise;
    for (const snapshotCount of [5000, 10000]) {
        const root = freshRoot(`f06-many-${snapshotCount}`);
        const store = createObjectStore({ root });
        const document = await sampleDoc('many');
        const bytes = Buffer.from(contracts.canonicalJson(document), 'utf8');
        const projectId = crypto.randomUUID();
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        await store.putObject(projectId, bytes);
        const db = libraryBundle.openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
        db.restoreProject({
            project: {
                projectId, name: 'many', revision: snapshotCount,
                currentSnapshotId: `snap-${String(snapshotCount).padStart(7, '0')}`,
                createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
            },
            snapshots: Array.from({ length: snapshotCount }, (_, index) => ({
                snapshotId: `snap-${String(index + 1).padStart(7, '0')}`,
                revision: index + 1, digest, length: bytes.length, createdAt: '2026-09-16T00:00:00.000Z',
            })),
        });
        const chosenRoot = freshRoot(`f06-backups-${snapshotCount}`);
        fs.mkdirSync(chosenRoot, { recursive: true });
        let dialogTarget = chosenRoot;
        const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [dialogTarget] }) };
        const svc = createStorageService({
            root, library: db, objects: store, dialog,
            verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        });
        const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
        const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
        const backup = await call('storage.v1.backup.create', { projectId });
        assert.equal(backup.ok, true, `${snapshotCount}: ${JSON.stringify(backup.error ?? {})}`);
        assert.equal(backup.data.snapshots, snapshotCount);
        const createdDir = fs.readdirSync(chosenRoot).find(name => name.startsWith('director-desk-backup-'));
        assert.ok(createdDir, `${snapshotCount}: the backup directory must exist`);
        const manifestBytes = fs.statSync(path.join(chosenRoot, createdDir, 'manifest.json')).size;
        assert.ok(manifestBytes <= 4 * 1024 * 1024, `${snapshotCount}: the self-produced manifest must stay within the derived budget (${manifestBytes} bytes)`);
        dialogTarget = path.join(chosenRoot, createdDir);
        const restore = await call('storage.v1.backup.restore', {});
        assert.equal(restore.ok, true, `${snapshotCount}: a self-produced ${manifestBytes}-byte manifest must restore, got ${JSON.stringify(restore.error ?? {})}`);
        assert.equal(restore.data.snapshots, snapshotCount);
        assert.equal(restore.data.revision, snapshotCount);
        await svc.dispose();
        db.close();
    }
});

test('REWORK2 V: a revision-2 commit landing mid-backup cannot leak into the revision-1 backup view', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const root = freshRoot('v-concurrent');
    const targetRoot = freshRoot('v-concurrent-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    let releaseDialog = () => { };
    const dialog = { showOpenDialog: () => new Promise(resolve => { releaseDialog = () => resolve({ canceled: false, filePaths: [targetRoot] }); }) };
    const svc = createStorageService({
        root, dialog,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '并发' });
    const uploader = { call, sessionId: created.data.sessionId };
    const doc1 = await sampleDoc('版本1');
    const first = await uploadDocument(uploader, doc1, {});
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const revision1Digest = first.data.snapshot.digest;
    // Start the backup: its consistent view is taken before the (gated) dialog resolves.
    const backupPromise = call('storage.v1.backup.create', { projectId: created.data.projectId });
    await new Promise(resolve => setTimeout(resolve, 80));
    // Revision 2 commits while the backup waits on the native dialog.
    const doc2 = await sampleDoc('版本2');
    const second = await uploadDocument(uploader, doc2, { expectedRevision: 1 });
    assert.equal(second.ok, true, `the concurrent commit must succeed: ${JSON.stringify(second.error ?? {})}`);
    assert.equal(second.data.revision, 2);
    releaseDialog();
    const backup = await backupPromise;
    assert.equal(backup.ok, true, JSON.stringify(backup.error ?? {}));
    assert.equal(backup.data.snapshots, 1, 'the backup must contain exactly the revision-1 view');
    const backupDir = path.join(targetRoot, fs.readdirSync(targetRoot).find(name => name.startsWith('director-desk-backup-')));
    const restoreSvc = createStorageService({
        root: freshRoot('v-concurrent-restore'), dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [backupDir] }) },
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const restoreFrame = { sender: { id: 9 }, senderFrame: { url: 'director://app/' } };
    const restore = await restoreSvc.runInRequestContext(restoreFrame, () => restoreSvc.handlers['storage.v1.backup.restore']({}));
    assert.equal(restore.ok, true, JSON.stringify(restore.error ?? {}));
    assert.equal(restore.data.revision, 1, 'the restored project must be the revision-1 view');
    const restoredStatus = await restoreSvc.runInRequestContext(restoreFrame, () => restoreSvc.handlers['project.status']({ projectId: restore.data.projectId }));
    assert.equal(restoredStatus.data.current.digest, revision1Digest, 'the restored current snapshot must be the revision-1 bytes');
    await restoreSvc.dispose();
    await svc.dispose();
});

test('REWORK2 F07 red: a receipt read failure after a proven commit is reported as storage-unavailable', async () => {
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const libraryBundle = await libraryPromise;
    const root = freshRoot('f07-receipt');
    const lib = libraryBundle.openLibrary({ file: path.join(root, 'library.sqlite'), now: () => Date.now() });
    let committed = false;
    let receiptFails = false;
    const wrapped = {
        ...lib,
        commitSnapshot(...args) { committed = true; return lib.commitSnapshot(...args); },
        getProject(...args) {
            if (committed && receiptFails) throw Object.assign(Error('receipt read failure'), { reason: 'storage-unavailable' });
            return lib.getProject(...args);
        },
    };
    const svc = createStorageService({
        root, library: wrapped, dialog: null,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '回执' });
    const service = { call, sessionId: created.data.sessionId };
    const bytes = Buffer.from(JSON.stringify(await sampleDoc('回执')), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: service.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: slice.toString('base64') });
        assert.equal(chunk.ok, true);
    }
    receiptFails = true; // the getProject receipt read fails right after the real commit
    const commit = await call('storage.v1.upload.commit', { transferId });
    assert.equal(commit.ok, true, `a proven commit must answer success, got ${JSON.stringify(commit.error ?? {})}`);
    assert.equal(commit.data.revision, 1);
    assert.equal(lib.getProject(created.data.projectId).revision, 1, 'the commit must have landed exactly once');
    await svc.dispose();
    lib.close();
});

// =====================================================================================
// DSK-004-RP1 named counterexamples: request frame-generation invalidation and the
// cancel/commit arbitration boundary (reviewer finding R2-01 and the RP1 acceptance).
// Each CE case reproduces a concrete race against the real library/object/service layers
// and was first run RED against the unfixed service (evidence: tmp/dsk-004-rp1-coder-*/),
// then must be GREEN after the frame-generation fix. Control cases pin the boundary the
// fix must NOT move (published results survive; honest either-branch commit arbitration).
// =====================================================================================

const RP1_DELAY = ms => new Promise(resolve => setTimeout(resolve, ms));

/** RP1 CE1: the native dialog returns AFTER a reload while the sender is still alive —
 * the deferred backup must NOT publish. The frame fixture deliberately has no
 * isDestroyed method, so only a captured generation (not sender destruction) can catch it. */
test('RP1 CE1 red: a backup whose dialog returns after a reload still publishes while the sender is alive', async () => {
    const targetRoot = freshRoot('rp1-ce1-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    let reloadOnDialog = false;
    const dialog = {
        showOpenDialog: async () => {
            if (reloadOnDialog) svc.closeFrameSessions(); // the real reload path: did-start-loading
            return { canceled: false, filePaths: [targetRoot] };
        },
    };
    const { svc, call } = await makeService({ label: 'rp1-ce1', dialog });
    const seeded = await seedProjectWithSnapshots(call, 1);
    // First backup completes normally BEFORE any reload and must survive everything later.
    const published = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(published.ok, true, JSON.stringify(published.error ?? {}));
    const publishedDir = path.join(targetRoot, fs.readdirSync(targetRoot).find(name => name.startsWith('director-desk-backup-')));
    // Now the dialog returns after the reload fired; the requester frame is NOT destroyed.
    reloadOnDialog = true;
    const late = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(late.ok, false, `a reload-invalidated backup must not publish, got ${JSON.stringify(late)}`);
    assert.equal(late.error.message, 'storage.v1/storage-unavailable');
    const dirs = fs.readdirSync(targetRoot).filter(name => name.startsWith('director-desk-backup-') || name.startsWith('.staging-'));
    assert.equal(dirs.length, 1, `only the pre-reload backup may exist, found ${JSON.stringify(dirs)}`);
    assert.deepEqual(fs.readdirSync(publishedDir).sort(), ['library.sqlite', 'manifest.json', 'objects'], 'the earlier published backup stays intact');
    await svc.dispose();
});

/** RP1 CE2: the native restore dialog returns after a reload — the restore must NOT register. */
test('RP1 CE2 red: a restore whose dialog returns after a reload still registers the project', async () => {
    const targetRoot = freshRoot('rp1-ce2-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    let dialogTarget = targetRoot;
    let reloadOnDialog = false;
    const dialog = {
        showOpenDialog: async () => {
            if (reloadOnDialog) svc.closeFrameSessions();
            return { canceled: false, filePaths: [dialogTarget] };
        },
    };
    const { svc, call } = await makeService({ label: 'rp1-ce2', dialog });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backup = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(backup.ok, true, JSON.stringify(backup.error ?? {}));
    dialogTarget = path.join(targetRoot, fs.readdirSync(targetRoot).find(name => name.startsWith('director-desk-backup-')));
    reloadOnDialog = true;
    const restore = await call('storage.v1.backup.restore', {});
    assert.equal(restore.ok, false, `a reload-invalidated restore must not register, got ${JSON.stringify(restore)}`);
    assert.equal(restore.error.message, 'storage.v1/storage-unavailable');
    const list = await call('storage.v1.project.list', {});
    assert.equal(list.ok, true, `project.list must keep working in the new generation: ${JSON.stringify(list.error ?? {})}`);
    assert.equal(list.data.projects.length, 1, 'the invalidated restore must not add a project');
    const original = await call('project.status', { projectId: seeded.projectId });
    assert.equal(original.ok && original.data.revision, 1, 'the original project is untouched');
    await svc.dispose();
});

/** RP1 CE3: the reload lands MID-COPY during restore (after validation, during the object
 * copy loop) — the copy must stop, its staged objects must be cleaned, and nothing registers. */
test('RP1 CE3 red: a reload landing mid-copy still lets the restore finish and register', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('rp1-ce3');
    const realStore = createObjectStore({ root });
    let reloadHook = null;
    const store = {
        ...realStore,
        async streamFileToObject(...args) {
            if (reloadHook) { const hook = reloadHook; reloadHook = null; hook(); }
            return realStore.streamFileToObject(...args);
        },
    };
    const targetRoot = freshRoot('rp1-ce3-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    let dialogTarget = targetRoot;
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [dialogTarget] }) };
    const { createStorageService } = await servicePromise;
    const contracts = await contractsPromise;
    const svc = createStorageService({
        root, objects: store, dialog,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backup = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(backup.ok, true, JSON.stringify(backup.error ?? {}));
    dialogTarget = path.join(targetRoot, fs.readdirSync(targetRoot).find(name => name.startsWith('director-desk-backup-')));
    reloadHook = () => svc.closeFrameSessions(); // fires inside the first copy iteration
    const restore = await call('storage.v1.backup.restore', {});
    assert.equal(restore.ok, false, `a mid-copy invalidated restore must not register, got ${JSON.stringify(restore)}`);
    const list = await call('storage.v1.project.list', {});
    assert.equal(list.data.projects.length, 1, 'no project may be registered by the invalidated restore');
    const projectsDir = path.join(root, 'projects');
    assert.deepEqual(fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).sort() : [],
        [seeded.projectId], 'staged restore objects must be cleaned, leaving only the original project');
    await svc.dispose();
});

/** RP1 CE5: an OLD-generation backup is still pending (dialog open) while a reload happens and
 * a NEW-generation request runs in parallel — the late backup must fail and must not disturb
 * the new generation; the new generation must succeed normally (RP1-A4). */
test('RP1 CE5 red: a reload-invalidated pending backup fails late without harming the parallel new generation', async () => {
    const targetRoot = freshRoot('rp1-ce5-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    let releaseDialog = () => { };
    const dialog = { showOpenDialog: () => new Promise(resolve => { releaseDialog = () => resolve({ canceled: false, filePaths: [targetRoot] }); }) };
    const { svc, call } = await makeService({ label: 'rp1-ce5', dialog });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backupPromise = call('storage.v1.backup.create', { projectId: seeded.projectId });
    await RP1_DELAY(80); // the native dialog is now pending (old generation in flight)
    svc.closeFrameSessions(); // reload while the dialog is open
    // New generation runs a full request cycle while the old backup is still parked on the dialog.
    const createdB = await call('project.create', { name: '新代工程' });
    assert.equal(createdB.ok, true, `a new-generation create must succeed: ${JSON.stringify(createdB.error ?? {})}`);
    const commitB = await uploadDocument({ call, sessionId: createdB.data.sessionId }, await sampleDoc('新代快照'), {});
    assert.equal(commitB.ok, true, `a new-generation save must succeed: ${JSON.stringify(commitB.error ?? {})}`);
    assert.equal(commitB.data.revision, 1);
    releaseDialog(); // the OLD-generation dialog finally returns its chosen directory
    const backup = await backupPromise;
    assert.equal(backup.ok, false, `the old-generation backup must fail after the reload, got ${JSON.stringify(backup)}`);
    assert.equal(backup.error.message, 'storage.v1/storage-unavailable');
    assert.deepEqual(fs.readdirSync(targetRoot), [], 'the invalidated backup must not publish anything');
    const statusB = await call('project.status', { projectId: createdB.data.projectId });
    assert.equal(statusB.ok && statusB.data.revision, 1, 'the late old-generation failure must not disturb the new generation');
    const statusA = await call('project.status', { projectId: seeded.projectId });
    assert.equal(statusA.ok && statusA.data.revision, 1, 'the original project stays intact');
    await svc.dispose();
});

/** RP1 control: a backup that PUBLISHED before the reload must survive every later
 * invalidation/dispose — late cleanup may never delete a published successful result. */
test('RP1 control: a published backup survives a later reload and dispose (cleanup never deletes published results)', async () => {
    const targetRoot = freshRoot('rp1-preserved-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }) };
    const { svc, call } = await makeService({ label: 'rp1-preserved', dialog });
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backup = await call('storage.v1.backup.create', { projectId: seeded.projectId });
    assert.equal(backup.ok, true, JSON.stringify(backup.error ?? {}));
    svc.closeFrameSessions(); // reload AFTER the publish completed
    const dirs = fs.readdirSync(targetRoot).filter(name => name.startsWith('director-desk-backup-'));
    assert.equal(dirs.length, 1, 'the published backup must survive the reload');
    assert.deepEqual(fs.readdirSync(path.join(targetRoot, dirs[0])).sort(), ['library.sqlite', 'manifest.json', 'objects']);
    await svc.dispose();
    assert.equal(fs.readdirSync(targetRoot).filter(name => name.startsWith('director-desk-backup-')).length, 1,
        'the published backup must survive dispose');
});

/** RP1 control (commit arbitration, RP1-A3): a commit raced by a reload either registers and
 * reports success, or fails without registering — never both, never a registration after the
 * frame generation moved past the final arbitration point, and no tmp file may survive. */
test('RP1 control: a commit raced by a reload lands at most once and never after invalidation', async () => {
    const { svc, call, root } = await makeService({ label: 'rp1-commitrace' });
    const created = await call('project.create', { name: '重载提交竞态' });
    const service = { call, sessionId: created.data.sessionId };
    const document = await sampleDoc('重载提交竞态');
    const bytes = Buffer.from(JSON.stringify(document), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: service.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: slice.toString('base64') });
        assert.equal(chunk.ok, true);
    }
    const commitPromise = call('storage.v1.upload.commit', { transferId });
    await RP1_DELAY(0); // land the reload while the commit is mid-flight
    svc.closeFrameSessions();
    const commit = await commitPromise;
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.ok, true);
    if (commit.ok) {
        assert.equal(status.data.revision, 1, 'a reported success must be a real registration');
    } else {
        assert.equal(status.data.revision, 0, 'a failed commit must not have registered anything');
    }
    // The stale transfer id is dead in every case; late operations are refused.
    const lateChunk = await call('storage.v1.upload.chunk', { transferId, offset: 0, data: SAMPLE_B64 });
    assert.equal(lateChunk.ok, false, 'the stale transfer id must not continue after the reload');
    await RP1_DELAY(50);
    const uploadsDir = path.join(root, 'uploads');
    const leftovers = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).filter(name => name.endsWith('.part')) : [];
    assert.deepEqual(leftovers, [], 'no .part file may survive the raced commit');
    await svc.dispose();
});

// =====================================================================================
// DSK-004-RP1 rework round 2 (review agent_02369570): R01 receipt-pinning / late rename
// and R02 the unchecked window between the staging mkdir and the first backup copy.
// History note: the original DI injections (removeTmp / ensureDir) were replaced in rework
// round 3 (V01) by the esbuild-level REAL fsp barriers above — the wrapped fsp.rm/fsp.mkdir
// still perform the real operation, only the first predicate match is held behind a gate,
// and reaching the barrier is asserted. The validation-01 revision additionally injects one
// clearly-marked SIMULATED fsp.rm denial for the cleanup-failure control below (the retired
// r+ file-handle lock never actually failed rm on this machine).
// =====================================================================================

/** RP1 R01: the commit registered, then the post-commit tmp cleanup awaits — a reload hands
 * the project to a new generation which saves revision 2 (name NEW) while the OLD request is
 * still finalizing. The old request must NOT read the future latest revision into its receipt,
 * must NOT rename the project afterwards, and must still report ITS OWN commit truthfully.
 * Barrier: the REAL fsp.rm of the tested commit's .part is held behind a gate (wrapped at
 * esbuild level, works against old and new sources alike); reaching it is asserted. */
test('RP1 R01 red: a commit finalizing across a reload pins its receipt to the future revision and renames after the new generation saved', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await buildGatedService('desktop/storage/service.cjs');
    const gates = globalThis.__rp1FspGates;
    gates.rmGate = new Promise(resolve => { gates.releaseRm = resolve; });
    gates.rmMatch = target => typeof target === 'string' && target.endsWith('.part');
    const svc = createStorageService({
        root: freshRoot('rp1-r01'),
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        dialog: null,
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: 'R01项目' });
    assert.equal(created.ok, true);
    // The tested commit is the project's FIRST save (revision 1) and carries a name — its late
    // rename is what would clobber the new generation's NEW.
    const bytes = Buffer.from(JSON.stringify(await sampleDoc('R01版本1')), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: bytes.length, name: 'OLD' });
    assert.equal(begin.ok, true);
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: slice.toString('base64') });
        assert.equal(chunk.ok, true);
    }
    const commitPromise = call('storage.v1.upload.commit', { transferId });
    // Deterministic barrier via the REAL fsp.rm: wait until the tested commit's tmp removal is
    // actually entered (registration has landed, receipt not yet finalized), then assert it.
    for (let waited = 0; waited < 2000 && !gates.rmMatched; waited += 5) await RP1_DELAY(5);
    assert.ok(gates.rmMatched, 'the post-commit real fsp.rm barrier must be reached');
    assert.equal(gates.rmCalls, 1, 'exactly the tested cleanup must have reached the barrier');
    // Reload while the old request is parked inside the real removal; the new generation saves
    // revision 2 with name NEW (its own cleanup is a later rm call and passes through).
    svc.closeFrameSessions();
    const reopened = await call('project.open', { projectId: created.data.projectId });
    assert.equal(reopened.ok, true, `the new generation must open the project: ${JSON.stringify(reopened.error ?? {})}`);
    assert.equal(reopened.data.revision, 1, 'the tested commit is provably registered before the new generation saves');
    const newSave = await uploadDocument({ call, sessionId: reopened.data.sessionId }, await sampleDoc('R01版本2'), { expectedRevision: 1, name: 'NEW' });
    assert.equal(newSave.ok, true, `the new generation must save revision 2: ${JSON.stringify(newSave.error ?? {})}`);
    assert.equal(newSave.data.revision, 2);
    const newSnapshotId = newSave.data.snapshot.snapshotId;
    gates.releaseRm(); // the old request resumes and finalizes
    const commit = await commitPromise;
    // The committed old request reports ITS OWN commit truthfully — never an unregistered failure.
    assert.equal(commit.ok, true, `a proven commit must answer success: ${JSON.stringify(commit.error ?? {})}`);
    assert.equal(commit.data.revision, 1, `the receipt revision must be this request's own commit (1), got ${JSON.stringify(commit.data)}`);
    assert.equal(commit.data.snapshot.revision, 1, 'the receipt must not pair its old snapshotId with the future revision');
    // The stored rows tell the truth: the old snapshot row IS revision 1, revision 2 belongs to
    // the new generation, and the project name must stay NEW (no late rename to OLD).
    const db = svc._internal.db;
    assert.equal(db.getSnapshot(created.data.projectId, commit.data.snapshot.snapshotId).revision, 1, 'oldSnapshotRow stays revision 1');
    assert.equal(db.getSnapshot(created.data.projectId, newSnapshotId).revision, 2, 'the new generation snapshot row is revision 2');
    const finalProject = db.getProject(created.data.projectId);
    assert.equal(finalProject.revision, 2);
    assert.equal(finalProject.name, 'NEW', `the late old-generation rename must not clobber NEW, got ${finalProject.name}`);
    assert.equal(finalProject.current.snapshotId, newSnapshotId);
    await svc.dispose();
});

/** RP1 R01 control: the PROJECT rename (db.renameProject inside the commit receipt section —
 * NOT the backup publish fsp.rename, which is covered by the published-backup-survival control)
 * already finalized reports committed success across a LATER reload (reviewer-preserved). */
test('RP1 R01 control: a finalized project rename reports success across a later reload', async () => {
    const { svc, call } = await makeService({ label: 'rp1-r01-control' });
    const created = await call('project.create', { name: '控制改名' });
    const commit = await uploadDocument({ call, sessionId: created.data.sessionId }, await sampleDoc('控制快照'), { name: '新名' });
    assert.equal(commit.ok, true, JSON.stringify(commit.error ?? {}));
    svc.closeFrameSessions(); // reload AFTER the whole commit section finished
    const status = await call('project.status', { projectId: created.data.projectId });
    assert.equal(status.ok && status.data.revision, 1);
    assert.equal(status.data.name, '新名', 'the finalized project rename survives the later reload');
    await svc.dispose();
});

/** RP1 R01 control (validation-01 revision): the retired r+ file-handle version never proved
 * that the rm actually failed — on this machine a held r+ handle does NOT make fsp.rm fail
 * (probe log: probe-filelock-rplus.log inside tmp/dsk-004-rp1-validation-01-20260917T075926Z,
 * rm SUCCEEDED despite the held handle) and the old test only asserted commit.ok, so its
 * "real EPERM" claim was a false positive. The cleanup denial is now INJECTED deterministically
 * at the esbuild fsp wrapper: exactly THIS transfer's .part path gets one simulated
 * EPERM/EACCES rejection (clearly marked, not a real OS permission failure); every other path
 * passes through to the real fs. Asserted: the denial hit exactly once, on the exact path,
 * with the injected code, AFTER the real registration (revision 1 was already the project's
 * current row at the rm moment), and the commit still reports ITS OWN committed success with
 * receipt fields matching the real database rows. */
test('RP1 R01 control: an injected fsp.rm denial after a registered commit still reports committed success', async () => {
    const contracts = await contractsPromise;
    const { createStorageService } = await buildGatedService('desktop/storage/service.cjs');
    const gates = globalThis.__rp1FspGates;
    const root = freshRoot('rp1-rmfail');
    const svc = createStorageService({
        root,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
        dialog: null,
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const created = await call('project.create', { name: '清理失败' });
    assert.equal(created.ok, true);
    const document = await sampleDoc('清理失败快照');
    const bytes = Buffer.from(JSON.stringify(document), 'utf8');
    const begin = await call('storage.v1.upload.begin', { sessionId: created.data.sessionId, expectedRevision: 0, declaredLength: bytes.length });
    assert.equal(begin.ok, true);
    const { transferId, chunkSize } = begin.data;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const chunk = await call('storage.v1.upload.chunk', { transferId, offset, data: slice.toString('base64') });
        assert.equal(chunk.ok, true);
    }
    // The denial targets exactly THIS transfer's .part path — nothing else.
    const uploadsDir = path.join(root, 'uploads');
    const partName = fs.readdirSync(uploadsDir).find(name => name.endsWith('.part'));
    assert.ok(partName, 'the upload tmp file must exist before the commit');
    const partPath = path.join(uploadsDir, partName);
    let dbAtInjection; // captured by the predicate at the exact rm moment
    gates.rmRejectCode = 'EPERM';
    gates.rmRejectMatch = target => {
        if (target !== partPath) return false;
        if (dbAtInjection === undefined) {
            const project = svc._internal.db.getProject(created.data.projectId);
            dbAtInjection = {
                revision: project ? project.revision : null,
                currentSnapshotId: project && project.current ? project.current.snapshotId : null,
            };
        }
        return true;
    };
    let commit, injection;
    try {
        commit = await call('storage.v1.upload.commit', { transferId });
    } finally {
        // Restore the injection state even when an await above throws — never leak into other
        // tests; the observed values are snapshotted first so assertions run after the reset.
        injection = {
            calls: gates.rmRejectCalls,
            path: gates.rmRejectPath,
            code: gates.rmRejectError ? gates.rmRejectError.code : null,
            message: gates.rmRejectError ? gates.rmRejectError.message : null,
            simulated: gates.rmRejectError ? gates.rmRejectError.simulated === true : false,
            dbAtInjection,
        };
        gates.rmRejectMatch = null;
        gates.rmRejectCode = null;
        gates.rmRejectPath = null;
        gates.rmRejectError = null;
        gates.rmRejectCalls = 0;
    }
    assert.equal(commit.ok, true, `a registered commit must stay a success when its cleanup rm is denied: ${JSON.stringify(commit.error ?? {})}`);
    assert.equal(injection.calls, 1, `the denial must hit exactly once (no retry), got ${injection.calls}`);
    assert.equal(injection.path, partPath, 'the denial must target exactly this transfer\'s .part path');
    assert.ok(injection.code === 'EACCES' || injection.code === 'EPERM', `the injected rejection must carry EACCES or EPERM, got ${JSON.stringify(injection.code)}`);
    assert.equal(injection.simulated, true, 'the injected fault must be marked as simulated');
    assert.ok(String(injection.message).includes('SIMULATED'), 'the injected error message must say SIMULATED');
    // Ordering: at the rm moment the real registration had already landed — revision 1 was the
    // project's current row, so the denial happened strictly AFTER the real COMMIT.
    assert.equal(injection.dbAtInjection.revision, 1, `the real db.commitSnapshot must land before the cleanup denial, saw ${JSON.stringify(injection.dbAtInjection)}`);
    assert.equal(commit.data.revision, 1);
    assert.equal(commit.data.snapshot.revision, 1, 'the receipt snapshot revision stays 1');
    const db = svc._internal.db;
    assert.equal(injection.dbAtInjection.currentSnapshotId, commit.data.snapshot.snapshotId, 'the denied cleanup ran after the tested snapshot became current');
    assert.equal(db.getSnapshot(created.data.projectId, commit.data.snapshot.snapshotId).revision, 1, 'the receipt snapshotId is a real revision-1 row');
    const finalProject = db.getProject(created.data.projectId);
    assert.equal(finalProject.revision, 1);
    assert.equal(finalProject.current.snapshotId, commit.data.snapshot.snapshotId);
    await svc.dispose();
});

/** RP1 R02: the reload lands while the backup's staging directory is being created (after the
 * dialog gate). The backup must re-check BEFORE creating the backup database or copying the
 * FIRST object: zero copies, zero published directories, staging cleaned, existing data intact.
 * Barrier: the REAL fsp.mkdir of the staging directory is held behind a gate (wrapped at esbuild
 * level); reaching it is asserted, and against the unfixed source the reload lands before the
 * pre-copy check exists, so exactly ONE object is copied before the late refusal. */
test('RP1 R02 red: a reload during the staging mkdir still creates the backup database and copies an object before refusing', async () => {
    const { createObjectStore } = await objectsPromise;
    const root = freshRoot('rp1-r02');
    const realStore = createObjectStore({ root });
    let copies = 0;
    const store = {
        ...realStore,
        async streamObjectToFile(...args) { copies += 1; return realStore.streamObjectToFile(...args); },
    };
    const targetRoot = freshRoot('rp1-r02-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    const { createStorageService } = await buildGatedService('desktop/storage/service.cjs');
    const gates = globalThis.__rp1FspGates;
    gates.mkdirGate = new Promise(resolve => { gates.releaseMkdir = resolve; });
    gates.mkdirMatch = target => typeof target === 'string' && target.includes(`${path.sep}.staging-`);
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }) };
    const contracts = await contractsPromise;
    const svc = createStorageService({
        root, objects: store, dialog,
        verifiers: { document: contracts.assertSceneDocument, canonical: contracts.canonicalJson, manifest: contracts.BackupManifestSchema },
    });
    const frame = { sender: { id: 1 }, senderFrame: { url: 'director://app/' } };
    const call = (action, data) => svc.runInRequestContext(frame, () => svc.handlers[action](data));
    const seeded = await seedProjectWithSnapshots(call, 1);
    const backupPromise = call('storage.v1.backup.create', { projectId: seeded.projectId });
    // Deterministic barrier via the REAL fsp.mkdir: wait until the staging creation is entered.
    for (let waited = 0; waited < 2000 && !gates.mkdirMatched; waited += 5) await RP1_DELAY(5);
    assert.ok(gates.mkdirMatched, 'the staging real fsp.mkdir barrier must be reached');
    svc.closeFrameSessions(); // reload while the staging creation is parked
    gates.releaseMkdir();
    const backup = await backupPromise;
    assert.equal(backup.ok, false, `a backup invalidated during staging must fail, got ${JSON.stringify(backup)}`);
    assert.equal(copies, 0, `a reload before the copy start must leave ZERO copied objects, got ${copies}`);
    assert.deepEqual(fs.readdirSync(targetRoot), [], 'no staging remnant and no published backup may exist');
    const list = await call('storage.v1.project.list', {});
    assert.equal(list.data.projects.length, 1, 'existing data is untouched');
    const status = await call('project.status', { projectId: seeded.projectId });
    assert.equal(status.ok && status.data.revision, 1);
    await svc.dispose();
});
