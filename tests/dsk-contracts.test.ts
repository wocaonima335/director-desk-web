// DSK-003 acceptance A1/A2/A4 harness (source-import side).
// Runs every shared fixture through the real schemas/dispatcher imported from shared/contracts,
// plus programmatic specials (NaN/Infinity, depth, size, cycles) and the sender/frame trust cases.
// tests/dsk-contracts.test.cjs runs the SAME fixture file through an esbuild CJS bundle; both must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    DSK_CONTRACT_VERSION,
    DSK_MAX_PAYLOAD_CHARS,
    DSK_MAX_PAYLOAD_DEPTH,
    DSK_SCHEMAS,
    EntityIdSchema,
    RoleIdSchema,
    dispatchDskRequest,
    isTrustedDskFrame,
} from '../shared/contracts/index.ts';
import type { DskCompiledOperation, DskResult } from '../shared/contracts/index.ts';
import type { EditOperation } from '../src/automation/edits.ts';
import type { DskError } from '../shared/contracts/dto.ts';

const fixtureFile = 'tests/fixtures/dsk-contracts/cases.json';
type Case = { id: string; schema?: keyof typeof DSK_SCHEMAS; valid?: boolean; data?: unknown; expectCode?: DskError['code']; input?: unknown };
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as { contractVersion: string; cases: Case[] };

async function runSharedCases(cases: Case[]) {
    let schemaCases = 0, ipcCases = 0;
    for (const item of cases) {
        if (item.schema) {
            schemaCases += 1;
            const result = DSK_SCHEMAS[item.schema].safeParse(item.data);
            assert.equal(result.success, item.valid, `${item.id}: expected ${item.valid ? 'accept' : 'reject'}`
                + (result.success ? '' : ` but failed: ${String(result.error.issues[0]?.message)}`));
        } else {
            ipcCases += 1;
            const result = await dispatchDskRequest(item.input, {});
            assert.equal(result.ok, false, `${item.id}: expected ok:false`);
            assert.equal(result.ok ? '' : result.error.code, item.expectCode, `${item.id}: unexpected code`
                + (result.ok ? '' : ` (${result.error.message})`));
        }
    }
    assert.equal(schemaCases + ipcCases, cases.length);
    return { schemaCases, ipcCases };
}

async function runProgrammaticSpecials() {
    const envelope = (action: string, data: unknown) => ({ version: DSK_CONTRACT_VERSION, action, data });
    const expectCode = async (input: unknown, code: DskError['code'], label: string) => {
        const result: DskResult<unknown> = await dispatchDskRequest(input, {});
        assert.equal(result.ok, false, label);
        assert.equal(result.ok ? '' : result.error.code, code, `${label}: unexpected code`);
    };
    // NaN / Infinity must be rejected even though JSON cannot carry them (structured clone can).
    await expectCode(envelope('state.get', { workflowId: NaN }), 'INVALID_PAYLOAD', 'NaN workflowId');
    const infinite = { workflowId: 'wf-0001', limit: Infinity };
    await expectCode(envelope('state.events', infinite), 'INVALID_PAYLOAD', 'Infinity limit');
    // Over-deep nesting beyond the 32-level guard.
    let deep: Record<string, unknown> = { workflowId: 'wf-0001' };
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < DSK_MAX_PAYLOAD_DEPTH + 8; i += 1) { cursor.nested = {}; cursor = cursor.nested as Record<string, unknown>; }
    await expectCode(envelope('plan.get', deep), 'INVALID_PAYLOAD', 'over-deep payload');
    // Oversized payload beyond the serialized char limit.
    await expectCode(envelope('state.get', { workflowId: 'wf-0001', filler: 'x'.repeat(DSK_MAX_PAYLOAD_CHARS) }), 'PAYLOAD_TOO_LARGE', 'oversized payload');
    // Cyclic structures are bounded by the node guard, never loop or crash.
    const cyclic: Record<string, unknown> = { workflowId: 'wf-0001' };
    cyclic.self = cyclic;
    await expectCode(envelope('state.get', cyclic), 'INVALID_PAYLOAD', 'cyclic payload');
}

function runTrustCases() {
    const window = { webContents: { id: 1 }, isDestroyed: () => false };
    const frame = (sender: unknown, url: unknown) => ({ sender, senderFrame: { url } });
    assert.equal(isTrustedDskFrame(frame(window.webContents, 'director://app/'), window), true, 'main frame accepted');
    assert.equal(isTrustedDskFrame(frame({ id: 2 }, 'director://app/'), window), false, 'foreign sender rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, 'director://app/child.html'), window), false, 'sub-frame url rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, 'https://evil.example/'), window), false, 'foreign origin rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, 'director://app/'), { ...window, isDestroyed: () => true }), false, 'destroyed window rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, null), window), false, 'missing frame url rejected');
}

test('dsk.v1 shared fixtures validate identically from source imports', async () => {
    assert.equal(DSK_CONTRACT_VERSION, fixture.contractVersion);
    assert.ok(fixture.cases.length >= 60, 'fixture set must stay substantial');
    const counts = await runSharedCases(fixture.cases);
    assert.ok(counts.schemaCases >= 40 && counts.ipcCases >= 10, 'both schema and IPC cases must exist');
});

test('dsk.v1 rejects non-finite, over-deep, oversized and cyclic payloads', runProgrammaticSpecials);

test('dsk.v1 IPC accepts only the app main frame sender', runTrustCases);

test('roleId and entityId are distinct, non-interchangeable identifier spaces', () => {
    // Same lexical value may be a legal entityId while being illegal as a roleId (uppercase/underscore).
    assert.equal(EntityIdSchema.safeParse('Ent_X_01').success, true);
    assert.equal(RoleIdSchema.safeParse('Ent_X_01').success, false);
    assert.equal(RoleIdSchema.safeParse('lin-xia').success, true);
});

test('compiled proposal operations stay structurally assignable to engine EditOperation', () => {
    // Compile-time gate: if the shared operation drifts from src/automation/edits.ts EditOperation,
    // the type below collapses to never and this assignment fails to compile.
    type CompiledOpsAreEngineOperations = DskCompiledOperation extends EditOperation ? true : never;
    const check: CompiledOpsAreEngineOperations[] = [true];
    assert.equal(check.length, 1);
});
