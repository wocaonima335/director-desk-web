// DSK-003 acceptance A2 harness (bundled-CJS side), rework-1 (R1/R5/R6/N2).
// Bundles shared/contracts/index.ts with the same esbuild settings used for the desktop payload,
// then runs the SAME fixture file, the SAME programmatic specials and the SAME R1 trust cases as
// tests/dsk-contracts.test.ts. Also executes the REAL desktop/preload.cjs inside a mock Electron
// renderer (node:vm) and asserts the captured dsk envelopes carry the shared contract version,
// channel and action — an executed check, not a static string search (N2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeVm = require('node:vm');
const esbuild = require('esbuild');

const fixtureFile = 'tests/fixtures/dsk-contracts/cases.json';
const outfile = path.resolve('tmp', `dsk-shared-contract-bundle-${process.pid}.cjs`);

// zod v4 reports unknown keys (code "unrecognized_keys") at the OBJECT's path with the key names
// in issue.keys; for contract purposes the offending location is object-path + key, so synthesize
// one target string per key. Mirrors the source-import harness exactly.
function issueTargets(issue) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        return issue.keys.map(key => [...issue.path, key].join('.'));
    }
    return [issue.path.join('.')];
}

process.on('exit', () => { try { fs.rmSync(outfile, { force: true }); } catch { /* best effort */ } });

let bundle = null;
function loadContracts() {
    if (!bundle) {
        // Same bundling approach as scripts/prepare-desktop.mjs for the main-process payload.
        esbuild.buildSync({ entryPoints: ['shared/contracts/index.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', charset: 'utf8', sourcemap: false, minify: true, logLevel: 'silent' });
        bundle = require(outfile);
    }
    return bundle;
}

async function runSharedCases(contracts, cases) {
    let schemaCases = 0, ipcCases = 0;
    for (const item of cases) {
        if (item.schema) {
            schemaCases += 1;
            const result = contracts.DSK_SCHEMAS[item.schema].safeParse(item.data);
            assert.equal(result.success, item.valid, `${item.id}: expected ${item.valid ? 'accept' : 'reject'}`
                + (result.success ? '' : ` but failed: ${String(result.error.issues[0] && result.error.issues[0].message)}`));
            if (item.valid === false && !result.success) {
                const issues = result.error.issues;
                for (const expected of item.expectPath || [])
                    assert.ok(issues.some(issue => issueTargets(issue).some(target => target.includes(expected))),
                        `${item.id}: no issue targets path ~ "${expected}" (got: ${issues.map(i => issueTargets(i).join('|')).join('; ') || 'none'})`);
                for (const expected of item.expectMessage || [])
                    assert.ok(issues.some(issue => issue.message.includes(expected)),
                        `${item.id}: no issue message ~ "${expected}" (got: ${issues.map(i => i.message).join('; ') || 'none'})`);
                if (item.expectIssueCount !== undefined)
                    assert.equal(issues.length, item.expectIssueCount,
                        `${item.id}: expected exactly ${item.expectIssueCount} issue(s), got ${issues.length}: ${issues.map(i => issueTargets(i).join('=') + ' ' + i.message).join('; ')}`);
            }
        } else {
            ipcCases += 1;
            const result = await contracts.dispatchDskRequest(item.input, {});
            assert.equal(result.ok, false, `${item.id}: expected ok:false`);
            assert.equal(result.ok ? '' : result.error.code, item.expectCode, `${item.id}: unexpected code`
                + (result.ok ? '' : ` (${result.error.message})`));
        }
    }
    assert.equal(schemaCases + ipcCases, cases.length);
    return { schemaCases, ipcCases };
}

function fixtureBreakdown(cases) {
    const breakdown = {};
    for (const item of cases) {
        const key = item.schema ? `${item.schema}:${item.valid ? 'valid' : 'invalid'}` : `IPC:${item.expectCode}`;
        breakdown[key] = (breakdown[key] || 0) + 1;
    }
    return breakdown;
}

async function runProgrammaticSpecials(contracts) {
    const envelope = (action, data) => ({ version: contracts.DSK_CONTRACT_VERSION, action, data });
    const expectCode = async (input, code, label) => {
        const result = await contracts.dispatchDskRequest(input, {});
        assert.equal(result.ok, false, label);
        assert.equal(result.ok ? '' : result.error.code, code, `${label}: unexpected code`);
    };
    await expectCode(envelope('state.get', { workflowId: NaN }), 'INVALID_PAYLOAD', 'NaN workflowId');
    await expectCode(envelope('state.events', { workflowId: 'wf-0001', limit: Infinity }), 'INVALID_PAYLOAD', 'Infinity limit');
    let deep = { workflowId: 'wf-0001' };
    let cursor = deep;
    for (let i = 0; i < contracts.DSK_MAX_PAYLOAD_DEPTH + 8; i += 1) { cursor.nested = {}; cursor = cursor.nested; }
    await expectCode(envelope('plan.get', deep), 'INVALID_PAYLOAD', 'over-deep payload');
    await expectCode(envelope('state.get', { workflowId: 'wf-0001', filler: 'x'.repeat(contracts.DSK_MAX_PAYLOAD_CHARS) }), 'PAYLOAD_TOO_LARGE', 'oversized payload');
    const cyclic = { workflowId: 'wf-0001' };
    cyclic.self = cyclic;
    await expectCode(envelope('state.get', cyclic), 'INVALID_PAYLOAD', 'cyclic payload');
}

function runTrustCases(contracts) {
    // R1: trust requires the EXACT main-frame object of the sending webContents; a same-URL
    // sub-frame is a different frame object and must not pass.
    const mainFrame = { url: 'director://app/' };
    const window = { webContents: { id: 1, mainFrame }, isDestroyed: () => false };
    const frame = (sender, senderFrame) => ({ sender, senderFrame });
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, mainFrame), window), true, 'main frame accepted');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, { url: 'director://app/' }), window), false, 'same-URL different frame rejected (R1)');
    assert.equal(contracts.isTrustedDskFrame(frame({ id: 2 }, mainFrame), window), false, 'foreign sender rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, { url: 'director://app/child.html' }), window), false, 'sub-frame url rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, { url: 'https://evil.example/' }), window), false, 'foreign origin rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, mainFrame), { ...window, isDestroyed: () => true }), false, 'destroyed window rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, null), window), false, 'missing frame rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, undefined), window), false, 'undefined frame rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, mainFrame), { webContents: { id: 1 }, isDestroyed: () => false }), false, 'window without mainFrame rejected');
}

test('dsk.v1 shared fixtures validate identically through the bundled CJS contract', async () => {
    const contracts = loadContracts();
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    assert.equal(contracts.DSK_CONTRACT_VERSION, fixture.contractVersion);
    assert.ok(fixture.cases.length >= 60, 'fixture set must stay substantial');
    const counts = await runSharedCases(contracts, fixture.cases);
    assert.ok(counts.schemaCases >= 80 && counts.ipcCases >= 25, 'both schema and IPC cases must stay substantial');
    console.log(`fixture counts: schema=${counts.schemaCases} ipc=${counts.ipcCases} total=${fixture.cases.length}`);
    console.log('fixture categories:', JSON.stringify(fixtureBreakdown(fixture.cases)));
    await runProgrammaticSpecials(contracts);
    runTrustCases(contracts);
});

test('dsk.v1 fixtures cover every whitelisted action in both directions (R6)', () => {
    const contracts = loadContracts();
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const actionOf = item => (item.input && typeof item.input === 'object' ? item.input.action : undefined);
    for (const action of contracts.DSK_ACTIONS) {
        assert.ok(fixture.cases.some(item => !item.schema && item.expectCode === 'NOT_IMPLEMENTED' && actionOf(item) === action),
            `missing NOT_IMPLEMENTED fixture for action ${action}`);
        assert.ok(fixture.cases.some(item => !item.schema && item.expectCode === 'INVALID_PAYLOAD' && actionOf(item) === action),
            `missing INVALID_PAYLOAD fixture for action ${action}`);
    }
    const covered = new Set(fixture.cases.filter(item => !item.schema && typeof actionOf(item) === 'string').map(item => actionOf(item)));
    for (const action of contracts.DSK_ACTIONS) assert.ok(covered.has(action), `action ${action} absent from fixture set`);
});

test('dsk.v1 rework-2 probe: the seven corrected counterexamples emit exactly their target issue (R6)', () => {
    // Reviewer finding: these seven cases previously carried an extra unrelated issue. Each now
    // breaks only its target constraint; the probe prints the actual issues for the record.
    const contracts = loadContracts();
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const probed = fixture.cases.filter(item => item.expectIssueCount !== undefined);
    assert.equal(probed.length, 7, 'exactly the seven rework-2 corrected fixtures carry expectIssueCount');
    for (const item of probed) {
        const result = contracts.DSK_SCHEMAS[item.schema].safeParse(item.data);
        assert.equal(result.success, false, `${item.id}: must stay rejected`);
        const issues = result.error.issues;
        assert.equal(issues.length, 1, `${item.id}: expected a single issue, got ${issues.length}`);
        console.log(`probe ${item.id}: ${issueTargets(issues[0]).join('|')} :: ${issues[0].message}`);
    }
});

test('dsk.v1 real preload envelopes carry the shared contract version through a mock Electron (N2)', () => {
    const contracts = loadContracts();
    const preloadSource = fs.readFileSync(path.resolve('desktop', 'preload.cjs'), 'utf8');
    const calls = [];
    let exposed = null;
    const contextBridge = { exposeInMainWorld: (key, api) => { exposed = { key, api }; } };
    const ipcRenderer = {
        invoke: (channel, payload) => { calls.push({ channel, payload }); return Promise.resolve({ ok: true, data: null }); },
        send: () => undefined,
        on: () => undefined,
        removeListener: () => undefined,
    };
    const sandboxRequire = id => {
        if (id === 'electron') return { contextBridge, ipcRenderer };
        throw new Error('real preload must not require modules other than electron: ' + id);
    };
    const sandbox = { require: sandboxRequire, module: { exports: {} }, exports: {}, console, Buffer };
    nodeVm.runInNewContext(preloadSource, sandbox, { filename: 'desktop/preload.cjs' });
    assert.ok(exposed, 'preload never exposed an API via contextBridge');
    assert.equal(exposed.key, 'directorDesktop');
    assert.equal(typeof exposed.api.dsk, 'function', 'real preload must expose a dsk method');

    // Drive the REAL preload dsk method over every whitelisted action; capture actual envelopes.
    for (const action of contracts.DSK_ACTIONS) void exposed.api.dsk(action, {});
    // And one parameterised call to verify the data field verbatim.
    void exposed.api.dsk('state.get', { workflowId: 'wf-0001' });
    return Promise.resolve().then(() => {
        assert.equal(calls.length, contracts.DSK_ACTIONS.length + 1, 'every dsk call must reach ipcRenderer.invoke exactly once');
        for (const [index, action] of contracts.DSK_ACTIONS.entries()) {
            const call = calls[index];
            assert.equal(call.channel, 'director-dsk', 'dsk must invoke the director-dsk channel');
            assert.deepEqual(Object.keys(call.payload), ['version', 'action', 'data'], 'envelope must be exactly version/action/data');
            assert.equal(call.payload.version, contracts.DSK_CONTRACT_VERSION, 'actual envelope version must equal the shared contract constant');
            assert.equal(call.payload.action, action);
            assert.deepEqual(call.payload.data, {});
        }
        const parameterised = calls[calls.length - 1];
        assert.equal(parameterised.channel, 'director-dsk');
        assert.equal(parameterised.payload.version, contracts.DSK_CONTRACT_VERSION);
        assert.equal(parameterised.payload.action, 'state.get');
        assert.deepEqual(parameterised.payload.data, { workflowId: 'wf-0001' });
    });
});
