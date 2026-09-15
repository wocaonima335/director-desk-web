// DSK-003 acceptance A2 harness (bundled-CJS side).
// Bundles shared/contracts/index.ts with the same esbuild settings used for the desktop payload,
// then runs the SAME fixture file and the SAME programmatic specials as tests/dsk-contracts.test.ts.
// Proves the shipped CJS bundle validates identically to the TypeScript source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const fixtureFile = 'tests/fixtures/dsk-contracts/cases.json';

async function runSharedCases(contracts, cases) {
    let schemaCases = 0, ipcCases = 0;
    for (const item of cases) {
        if (item.schema) {
            schemaCases += 1;
            const result = contracts.DSK_SCHEMAS[item.schema].safeParse(item.data);
            assert.equal(result.success, item.valid, `${item.id}: expected ${item.valid ? 'accept' : 'reject'}`
                + (result.success ? '' : ` but failed: ${String(result.error.issues[0] && result.error.issues[0].message)}`));
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
    const window = { webContents: { id: 1 }, isDestroyed: () => false };
    const frame = (sender, url) => ({ sender, senderFrame: { url } });
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, 'director://app/'), window), true, 'main frame accepted');
    assert.equal(contracts.isTrustedDskFrame(frame({ id: 2 }, 'director://app/'), window), false, 'foreign sender rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, 'director://app/child.html'), window), false, 'sub-frame url rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, 'https://evil.example/'), window), false, 'foreign origin rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, 'director://app/'), { ...window, isDestroyed: () => true }), false, 'destroyed window rejected');
    assert.equal(contracts.isTrustedDskFrame(frame(window.webContents, null), window), false, 'missing frame url rejected');
}

test('dsk.v1 shared fixtures validate identically through the bundled CJS contract', async t => {
    const outfile = path.resolve('tmp', `dsk-shared-contract-bundle-${process.pid}.cjs`);
    t.after(() => { fs.rmSync(outfile, { force: true }); });
    // Same bundling approach as scripts/prepare-desktop.mjs for the main-process payload.
    await esbuild.build({ entryPoints: ['shared/contracts/index.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', charset: 'utf8', sourcemap: false, minify: true, logLevel: 'silent' });
    const contracts = require(outfile);
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    assert.equal(contracts.DSK_CONTRACT_VERSION, fixture.contractVersion);
    assert.ok(fixture.cases.length >= 60, 'fixture set must stay substantial');
    const counts = await runSharedCases(contracts, fixture.cases);
    assert.ok(counts.schemaCases >= 40 && counts.ipcCases >= 10, 'both schema and IPC cases must exist');
    await runProgrammaticSpecials(contracts);
    runTrustCases(contracts);
});
