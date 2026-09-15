// DSK-003 acceptance A1/A2/A4 harness (source-import side), rework-1 (R1/R2/R5/R6).
// Runs every shared fixture through the real schemas/dispatcher imported from shared/contracts,
// plus programmatic specials (NaN/Infinity, depth, size, cycles) and the sender/main-frame trust
// cases. Invalid fixtures are single-factor and carry expectPath/expectMessage so the asserted
// failure is the INTENDED one, not a bystander error. tests/dsk-contracts.test.cjs runs the SAME
// fixture file through an esbuild CJS bundle; both must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    DSK_ACTIONS,
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
type Case = {
    id: string; schema?: keyof typeof DSK_SCHEMAS; valid?: boolean; data?: unknown;
    expectCode?: DskError['code']; input?: unknown;
    expectPath?: string[]; expectMessage?: string[]; expectIssueCount?: number;
};
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as { contractVersion: string; cases: Case[] };

// zod v4 reports unknown keys (code "unrecognized_keys") at the OBJECT's path with the key names
// in issue.keys; for contract purposes the offending location is object-path + key, so synthesize
// one target string per key. Every other issue targets its own path directly.
function issueTargets(issue: { path: ReadonlyArray<PropertyKey>; code?: string; keys?: string[] }): string[] {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        return issue.keys.map(key => [...issue.path, key].join('.'));
    }
    return [issue.path.map(String).join('.')];
}

async function runSharedCases(cases: Case[]) {
    let schemaCases = 0, ipcCases = 0;
    for (const item of cases) {
        if (item.schema) {
            schemaCases += 1;
            const result = DSK_SCHEMAS[item.schema].safeParse(item.data);
            assert.equal(result.success, item.valid, `${item.id}: expected ${item.valid ? 'accept' : 'reject'}`
                + (result.success ? '' : ` but failed: ${String(result.error.issues[0]?.message)}`));
            if (item.valid === false && !result.success) {
                const issues = result.error.issues;
                for (const expected of item.expectPath ?? [])
                    assert.ok(issues.some(issue => issueTargets(issue).some(target => target.includes(expected))),
                        `${item.id}: no issue targets path ~ "${expected}" (got: ${issues.map(i => issueTargets(i).join('|')).join('; ') || 'none'})`);
                for (const expected of item.expectMessage ?? [])
                    assert.ok(issues.some(issue => issue.message.includes(expected)),
                        `${item.id}: no issue message ~ "${expected}" (got: ${issues.map(i => i.message).join('; ') || 'none'})`);
                if (item.expectIssueCount !== undefined)
                    assert.equal(issues.length, item.expectIssueCount,
                        `${item.id}: expected exactly ${item.expectIssueCount} issue(s), got ${issues.length}: ${issues.map(i => issueTargets(i).join('=') + ' ' + i.message).join('; ')}`);
            }
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

function fixtureBreakdown(cases: Case[]) {
    const breakdown: Record<string, number> = {};
    for (const item of cases) {
        const key = item.schema ? `${item.schema}:${item.valid ? 'valid' : 'invalid'}` : `IPC:${item.expectCode}`;
        breakdown[key] = (breakdown[key] ?? 0) + 1;
    }
    return breakdown;
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
    // R1: trust requires the EXACT main-frame object of the sending webContents; a same-URL
    // sub-frame is a different frame object and must not pass.
    const mainFrame = { url: 'director://app/' };
    const window = { webContents: { id: 1, mainFrame }, isDestroyed: () => false };
    const frame = (sender: unknown, senderFrame: unknown) => ({ sender, senderFrame });
    assert.equal(isTrustedDskFrame(frame(window.webContents, mainFrame), window), true, 'main frame accepted');
    assert.equal(isTrustedDskFrame(frame(window.webContents, { url: 'director://app/' }), window), false, 'same-URL different frame rejected (R1)');
    assert.equal(isTrustedDskFrame(frame({ id: 2 }, mainFrame), window), false, 'foreign sender rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, { url: 'director://app/child.html' }), window), false, 'sub-frame url rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, { url: 'https://evil.example/' }), window), false, 'foreign origin rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, mainFrame), { ...window, isDestroyed: () => true }), false, 'destroyed window rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, null), window), false, 'missing frame rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, undefined), window), false, 'undefined frame rejected');
    assert.equal(isTrustedDskFrame(frame(window.webContents, mainFrame), { webContents: { id: 1 }, isDestroyed: () => false }), false, 'window without mainFrame rejected');
}

test('dsk.v1 shared fixtures validate identically from source imports', async () => {
    assert.equal(DSK_CONTRACT_VERSION, fixture.contractVersion);
    assert.ok(fixture.cases.length >= 60, 'fixture set must stay substantial');
    const counts = await runSharedCases(fixture.cases);
    assert.ok(counts.schemaCases >= 80 && counts.ipcCases >= 25, 'both schema and IPC cases must stay substantial');
    console.log(`fixture counts: schema=${counts.schemaCases} ipc=${counts.ipcCases} total=${fixture.cases.length}`);
    console.log('fixture categories:', JSON.stringify(fixtureBreakdown(fixture.cases)));
});

test('dsk.v1 fixtures cover every whitelisted action in both directions (R6)', () => {
    const actionOf = (item: Case) => (item.input as { action?: unknown } | null | undefined)?.action;
    for (const action of DSK_ACTIONS) {
        assert.ok(fixture.cases.some(item => !item.schema && item.expectCode === 'NOT_IMPLEMENTED' && actionOf(item) === action),
            `missing NOT_IMPLEMENTED fixture for action ${action}`);
        assert.ok(fixture.cases.some(item => !item.schema && item.expectCode === 'INVALID_PAYLOAD' && actionOf(item) === action),
            `missing INVALID_PAYLOAD fixture for action ${action}`);
    }
    const covered = new Set(fixture.cases.filter(item => !item.schema && typeof actionOf(item) === 'string').map(item => String(actionOf(item))));
    for (const action of DSK_ACTIONS) assert.ok(covered.has(action), `action ${action} absent from fixture set`);
});

test('dsk.v1 rework-2 probe: the seven corrected counterexamples emit exactly their target issue (R6)', () => {
    // Reviewer finding: these seven cases previously carried an extra unrelated issue. Each now
    // breaks only its target constraint; the probe prints the actual issues for the record.
    const probed = fixture.cases.filter(item => item.expectIssueCount !== undefined);
    assert.equal(probed.length, 7, 'exactly the seven rework-2 corrected fixtures carry expectIssueCount');
    for (const item of probed) {
        const result = DSK_SCHEMAS[item.schema!].safeParse(item.data);
        assert.equal(result.success, false, `${item.id}: must stay rejected`);
        const issues = (result as Extract<typeof result, { success: false }>).error.issues;
        assert.equal(issues.length, 1, `${item.id}: expected a single issue, got ${issues.length}`);
        console.log(`probe ${item.id}: ${issueTargets(issues[0]).join('|')} :: ${issues[0].message}`);
    }
});

test('dsk.v1 rejects non-finite, over-deep, oversized and cyclic payloads', runProgrammaticSpecials);

test('dsk.v1 IPC accepts only the exact main frame of the app webContents (R1)', runTrustCases);

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
