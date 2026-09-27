// DSK-004 renderer-side harness: ManagedProjectController wire flows against a scripted dsk,
// the RecoveryAutosave managed gate (no legacy recovery writes while managed) and the
// save-dirty rules in project-save (epoch/revision capture, uncertain commits, export copies).
// No real DOM: only a minimal document/window shim for the status helpers in project-save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedProjectController, StorageRequestError, leaveManagedBeforeSwitch, type DskReply, type DskCaller, type SaveOutcome } from '../src/editor/managed-project.ts';
import { RecoveryAutosave } from '../src/editor/recovery-autosave.ts';
import { CanonicalLimitError, canonicalJson } from '../shared/storage/canonical.ts';
import { STORAGE_MAX_PROJECT_BYTES } from '../shared/contracts/index.ts';
import { readSceneDocument, type SceneDocument } from '../src/scenes/sequence-project.ts';
import { demoProject } from '../src/model.ts';
import { saveProjectFile, exportProjectCopy } from '../src/ui/project-save.ts';

// The canonical serializer must produce identical text when compiled to CJS for the main process
// (tests/dsk-storage.test.cjs asserts the same fixture vector on the bundled side).
assert.equal(canonicalJson({ b: 1, a: [{ z: 1, y: [2, 1] }], c: null, d: '文本' }), '{"a":[{"y":[2,1],"z":1}],"b":1,"c":null,"d":"文本"}');
// RP5: canonical bytes stay byte-compatible with the previous JSON.stringify(sorted) output —
// JSON array-index keys (canonical non-negative integers) first in ascending NUMERIC order, every
// other key in lexicographic UTF-16 order, plus escapes, lone surrogates, and raw surrogate pairs
// that encode as one 4-byte UTF-8 sequence.
assert.equal(canonicalJson({ 10: 'a', 2: 'b', 1: 'c' }), '{"1":"c","2":"b","10":"a"}');
// Mixed ordering: integer indices numerically first, non-index numeric strings ("01", "-1", "2x")
// and normal keys after them in code-unit order — exactly JSON.stringify of the sorted object.
assert.equal(
    canonicalJson({ 10: 'a', 2: 'b', 1: 'c', '2x': 'd', '01': 'e', '-1': 'f', z: 'g', A: 'h' }),
    '{"1":"c","2":"b","10":"a","-1":"f","01":"e","2x":"d","A":"h","z":"g"}',
);
assert.equal(canonicalJson({ 文: 1, k: 2 }), '{"k":2,"文":1}');
assert.equal(canonicalJson({ k: 'a"b\\c\nd\te\u0001\u001f' }), '{"k":"a\\"b\\\\c\\nd\\te\\u0001\\u001f"}');
assert.equal(canonicalJson({ s: '𝌆' }), '{"s":"𝌆"}');
assert.equal(canonicalJson({ s: '\ud800' }), '{"s":"\\ud800"}');
// Per-token UTF-8 accounting: {"s":X} = 2 braces + 3 key bytes + colon + 2 quotes + value bytes —
// 3 bytes for 文, 6 per escaped lone surrogate, 4 per raw surrogate pair.
assert.equal(canonicalJson({ s: '文' }), '{"s":"文"}');
assert.equal(Buffer.byteLength(canonicalJson({ s: '文' }), 'utf8'), 11);
assert.equal(Buffer.byteLength(canonicalJson({ s: '\ud800'.repeat(4) }), 'utf8'), 32);
assert.equal(Buffer.byteLength(canonicalJson({ s: '𝌆' }), 'utf8'), 12);

function makeDocument(name?: string): SceneDocument {
    const document = readSceneDocument(demoProject());
    if (name) document.name = name;
    return document;
}

const OK = (data: unknown): DskReply => ({ ok: true, data });
const FAIL = (reason: string, detail: string): DskReply => ({ ok: false, error: { code: 'ACTION_FAILED', message: `storage.v1/${reason}`, details: [detail] } });

test('bootstrap adopts the persisted identity without opening anything', async () => {
    const calls: Array<{ action: string; data: unknown }> = [];
    const controller = new ManagedProjectController((async (action, data) => {
        calls.push({ action, data });
        return OK({ mode: 'managed', projectId: 'proj-0001', name: '上次' });
    }) as DskCaller);
    const boot = await controller.bootstrap();
    assert.deepEqual(boot, { mode: 'managed', projectId: 'proj-0001', name: '上次' });
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.sessionId, null, 'bootstrap must not open a session');
    assert.equal(calls.length, 1);
});

test('saveSnapshot uploads ordered base64 chunks and updates revision only on success', async () => {
    const log: Array<{ action: string; data: unknown }> = [];
    const document = makeDocument('保存');
    // RP5: uploads carry the canonical bytes, so the chunk expectation uses canonicalJson too.
    const bytes = new TextEncoder().encode(canonicalJson(document));
    const ref = { version: 'dsk.v1', snapshotId: 'snap-0001', projectId: 'proj-0001', revision: 1, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
    const dsk: DskCaller = async (action, data) => {
        log.push({ action, data: data as unknown });
        if (action === 'project.create') return OK({ sessionId: 'sess-0001', projectId: 'proj-0001', name: '保存', revision: 0, current: null, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-0001', declaredLength: bytes.length, chunkSize: 1024 });
        if (action === 'storage.v1.upload.chunk') {
            const payload = data as { offset: number; data: string };
            const expected = bytes.subarray(payload.offset, Math.min(payload.offset + 1024, bytes.length));
            assert.equal(Buffer.from(payload.data, 'base64').toString('hex'), Buffer.from(expected).toString('hex'), 'chunk bytes must round-trip in order');
            return OK({ received: payload.offset + expected.length });
        }
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref, revision: 1 });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId, projectId: 'proj-0001' });
        throw Error('unexpected action ' + action);
    };
    const controller = new ManagedProjectController(dsk);
    await controller.create('保存');
    const outcome = await controller.saveSnapshot(document);
    assert.equal(outcome.status, 'saved');
    // F08: a first save without activate() updates the staged candidate, not the active binding.
    assert.equal(controller.candidate?.revision, 1);
    assert.equal(controller.candidate?.current?.snapshotId, 'snap-0001');
    assert.equal(controller.revision, 0, 'the active binding is untouched before activation');
    await controller.activate();
    assert.equal(controller.revision, 1, 'activate promotes the candidate revision');
    const actions = log.map(entry => entry.action);
    assert.equal(actions[0], 'project.create');
    assert.equal(actions[1], 'storage.v1.upload.begin');
    assert.equal(actions[actions.length - 2], 'storage.v1.upload.commit');
    assert.equal(actions[actions.length - 1], 'storage.v1.session.activate');
    const expectedChunks = Math.ceil(bytes.length / 1024);
    assert.equal(actions.filter(name => name === 'storage.v1.upload.chunk').length, expectedChunks);
    assert.deepEqual(actions.slice(2, 2 + expectedChunks), actions.slice(2, -1).filter(name => name === 'storage.v1.upload.chunk'));
});

test('over-limit uploads are refused locally; busy leases surface the frozen reason', async () => {
    const actions: string[] = [];
    const ref = { version: 'dsk.v1', snapshotId: 'snap-0002', projectId: 'proj-0002', revision: 4, digest: 'c'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
    const controller = new ManagedProjectController((async action => {
        actions.push(action);
        if (action === 'project.open') return OK({ sessionId: 'sess-0002', projectId: 'proj-0002', name: '忙', revision: 4, current: ref, leaseOwned: false, leaseBusy: true });
        if (action === 'storage.v1.upload.begin') return FAIL('lease-busy', '其他进程正在写入该项目，保存被拒绝');
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-0002');
    // 64 MiB cap is exceeded through a long document name; nothing reaches the wire.
    const longNameDocument = { ...makeDocument(), name: 'x'.repeat(64 * 1024 * 1024) } as unknown as SceneDocument;
    const tooLarge = await controller.saveSnapshot(longNameDocument);
    assert.equal(tooLarge.status, 'failed');
    assert.equal((tooLarge as { reason: string }).reason, 'upload-too-large');
    assert.deepEqual(actions, ['project.open'], 'over-limit uploads must not touch the wire');
    // Busy lease: begin is refused with the frozen lease-busy reason and nothing uploads.
    const busy = await controller.saveSnapshot(makeDocument('忙'));
    assert.equal(busy.status, 'failed');
    assert.equal((busy as { reason: string }).reason, 'lease-busy');
});

// --- RP5 bounded canonicalization --------------------------------------------------------------

function documentWithPaddedName(totalCanonicalBytes: number): SceneDocument {
    const base = makeDocument('定长');
    const nameBytes = Buffer.byteLength(base.name, 'utf8');
    const baseBytes = Buffer.byteLength(canonicalJson(base), 'utf8');
    return { ...base, name: 'x'.repeat(totalCanonicalBytes - baseBytes + nameBytes) } as unknown as SceneDocument;
}

test('RP5: an exactly 67108864-byte canonical document saves; one more byte is refused locally', async () => {
    const ref = { version: 'dsk.v1', snapshotId: 'snap-max', projectId: 'proj-max', revision: 1, digest: 'e'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
    const exact = documentWithPaddedName(STORAGE_MAX_PROJECT_BYTES);
    assert.equal(Buffer.byteLength(canonicalJson(exact), 'utf8'), STORAGE_MAX_PROJECT_BYTES);
    let declaredLength = 0;
    let chunks = 0;
    const controller = new ManagedProjectController((async (action, data) => {
        if (action === 'storage.v1.upload.begin') {
            declaredLength = (data as { declaredLength: number }).declaredLength;
            return OK({ transferId: 'up-max', declaredLength, chunkSize: 65536 });
        }
        if (action === 'storage.v1.upload.chunk') { chunks += 1; return OK({ received: (data as { offset: number }).offset + 65536 }); }
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref, revision: 1 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-max', projectId: 'proj-max', projectName: '满额', revision: 0, current: null, leaseOwned: true });
    controller.identity = 'managed';
    const saved = await controller.saveSnapshot(exact);
    assert.equal(saved.status, 'saved');
    assert.equal(declaredLength, STORAGE_MAX_PROJECT_BYTES, 'the full budget is uploadable');
    assert.equal(chunks, Math.ceil(STORAGE_MAX_PROJECT_BYTES / 65536));
    assert.equal(controller.revision, 1);
    assert.equal(controller.current?.snapshotId, 'snap-max');

    // Exactly one byte beyond the budget: refused before anything reaches the wire.
    const wire: string[] = [];
    const refusedController = new ManagedProjectController((async action => {
        wire.push(action);
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    refusedController.restoreBinding({ sessionId: 'sess-max', projectId: 'proj-max', projectName: '满额', revision: 2, current: ref, leaseOwned: true });
    refusedController.identity = 'managed';
    const refused = await refusedController.saveSnapshot(documentWithPaddedName(STORAGE_MAX_PROJECT_BYTES + 1));
    assert.equal(refused.status, 'failed');
    assert.equal((refused as { reason: string }).reason, 'upload-too-large');
    assert.deepEqual(wire, [], 'the 67108865-byte document must not touch the wire');
    assert.equal(refusedController.revision, 2, 'a refused save must not modify revision');
    assert.equal(refusedController.current, ref, 'a refused save must not modify current');
});

test('RP5: depth/node budgets reject at 65/1000001 and map to document-invalid without wire traffic', async () => {
    const nested = (levels: number): unknown => { let value: unknown = 1; for (let index = 0; index < levels; index += 1) value = [value]; return value; };
    // Root depth counts as 1: 63 nested arrays put the leaf value at depth 64 (legal), one more
    // array reaches depth 65 and is rejected. Every value is a node; property keys are not.
    assert.equal(typeof canonicalJson(nested(63)), 'string');
    assert.throws(() => canonicalJson(nested(64)), (error: unknown) => error instanceof CanonicalLimitError && error.limit === 'depth');
    assert.equal(typeof canonicalJson(new Array(999999).fill(1)), 'string', 'exactly 1000000 nodes stay legal');
    assert.throws(() => canonicalJson(new Array(1000000).fill(1)), (error: unknown) => error instanceof CanonicalLimitError && error.limit === 'nodes');

    const actions: string[] = [];
    const controller = new ManagedProjectController((async action => {
        actions.push(action);
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-deep', projectId: 'proj-deep', projectName: '深度', revision: 3, current: null, leaseOwned: true });
    controller.identity = 'managed';
    const expectInvalid = (outcome: SaveOutcome) => {
        assert.equal(outcome.status, 'failed');
        assert.equal((outcome as { reason: string }).reason, 'document-invalid');
    };
    expectInvalid(await controller.saveSnapshot({ ...makeDocument('深度'), zzDepth: nested(64) } as unknown as SceneDocument));
    expectInvalid(await controller.saveSnapshot({ ...makeDocument('深度'), zzNodes: new Array(1000000).fill(1) } as unknown as SceneDocument));
    expectInvalid(await controller.saveSnapshot({ ...makeDocument('深度'), zzFinite: Number.NaN } as unknown as SceneDocument));
    assert.deepEqual(actions, [], 'invalid documents must never reach the wire');
    assert.equal(controller.revision, 3, 'failed canonicalization must not modify revision');
    assert.equal(controller.current, null, 'failed canonicalization must not modify current');
});

test('RP5 rework: array null entries obey depth+1; JSON-invisible roots are refused before upload', async () => {
    // Null wrapped in arrays counts exactly like any other leaf: 63 arrays put the null at depth
    // 64 (legal), the 64th array would put it at depth 65 and is rejected. Every wrapper is a
    // node too, so the node budget applies through the same walk.
    const nestedNull = (levels: number): unknown => { let value: unknown = null; for (let index = 0; index < levels; index += 1) value = [value]; return value; };
    assert.equal(canonicalJson(nestedNull(63)), '['.repeat(63) + 'null' + ']'.repeat(63));
    assert.throws(() => canonicalJson(nestedNull(64)), (error: unknown) => error instanceof CanonicalLimitError && error.limit === 'depth');
    assert.throws(() => canonicalJson(nestedNull(65)), (error: unknown) => error instanceof CanonicalLimitError && error.limit === 'depth');

    const actions: string[] = [];
    const controller = new ManagedProjectController((async action => {
        actions.push(action);
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-null', projectId: 'proj-null', projectName: '空值', revision: 7, current: null, leaseOwned: true });
    controller.identity = 'managed';
    const expectInvalid = (outcome: SaveOutcome) => {
        assert.equal(outcome.status, 'failed');
        assert.equal((outcome as { reason: string }).reason, 'document-invalid');
    };
    // The document root counts as depth 1 and its property values start at depth 2, so
    // nestedNull(63) puts the null leaf at exactly depth 65 (STORAGE_MAX_DEPTH is 64, so 65 is
    // the first rejected depth). It is document-invalid at the save entry: no upload.begin,
    // revision/current untouched.
    expectInvalid(await controller.saveSnapshot({ ...makeDocument('空值'), zzNullDepth: nestedNull(63) } as unknown as SceneDocument));
    // A root value that produces no canonical text at all (undefined) is refused before upload.
    expectInvalid(await controller.saveSnapshot(undefined as unknown as SceneDocument));
    assert.deepEqual(actions, [], 'refused saves must not reach the wire');
    assert.equal(controller.revision, 7, 'a refused save must not modify revision');
    assert.equal(controller.current, null, 'a refused save must not modify current');
    assert.equal(controller.candidate, null, 'a refused save must not stage anything');
});

test('uncertain commit keeps revision unchanged so the renderer keeps dirty state', async () => {
    const controller = new ManagedProjectController((async action => {
        if (action === 'project.open') return OK({ sessionId: 'sess-0001', projectId: 'proj-0001', name: '回执', revision: 1, current: null, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-0009', declaredLength: 4, chunkSize: 1024 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return FAIL('outcome-unknown', '提交结果不确定，请先查询项目状态，不要盲目重试');
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-0001');
    const outcome = await controller.saveSnapshot(makeDocument('回执'));
    assert.equal(outcome.status, 'outcome-unknown');
    // F08: the open is staged; an uncertain commit must not advance the candidate revision.
    assert.equal(controller.candidate?.revision, 1);
    assert.equal(controller.candidate?.current, null);
    assert.equal(controller.revision, 0, 'the active binding stays untouched');
});

test('failed upload aborts the transfer', async () => {
    const controller = new ManagedProjectController((async action => {
        if (action === 'project.open') return OK({ sessionId: 'sess-0001', projectId: 'proj-0001', name: '失败', revision: 0, current: null, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-0010', declaredLength: 4, chunkSize: 1024 });
        if (action === 'storage.v1.upload.chunk') return FAIL('upload-format', '上传块顺序不正确，传输已取消');
        if (action === 'storage.v1.transfer.abort') return OK({ aborted: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-0001');
    const outcome = await controller.saveSnapshot(makeDocument('失败'));
    assert.equal(outcome.status, 'failed');
    assert.equal((outcome as { reason: string }).reason, 'upload-format');
});

test('download reassembles chunks in order and validates the document with the shared verifier', async () => {
    const document = makeDocument('下载');
    const canonical = Buffer.from(JSON.stringify(document), 'utf8');
    const ref = { version: 'dsk.v1', snapshotId: 'snap-0002', projectId: 'proj-0002', revision: 4, digest: 'c'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
    const chunkReplies = (action: string, bytes: Buffer, chunkSize: number): Array<[string, DskReply]> => {
        const replies: Array<[string, DskReply]> = [];
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const final = offset + chunkSize >= bytes.length;
            replies.push([action, OK({ offset, data: bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)).toString('base64'), final })]);
        }
        return replies;
    };
    const script: Array<[string, DskReply]> = [
        ['project.open', OK({ sessionId: 'sess-0002', projectId: 'proj-0002', name: '下载', revision: 4, current: ref, leaseOwned: true, leaseBusy: false })],
        ['storage.v1.snapshot.read', OK({ snapshot: ref, transferId: 'dl-0001', length: canonical.length, chunkSize: 64, chunks: Math.ceil(canonical.length / 64) })],
        ...chunkReplies('storage.v1.snapshot.download.chunk', canonical, 64),
    ];
    const controller = new ManagedProjectController((async (action, data) => {
        const next = script.shift();
        assert.ok(next, 'script exhausted');
        assert.equal(next[0], action);
        void data;
        return next[1];
    }) as DskCaller);
    await controller.open('proj-0002');
    const downloaded = await controller.download();
    assert.deepEqual(JSON.parse(JSON.stringify(downloaded.document)), JSON.parse(JSON.stringify(document)));
    assert.equal(downloaded.snapshot.snapshotId, 'snap-0002');
    // A tampered payload must be rejected by the shared verifier, not applied blindly.
    const broken = new ManagedProjectController((async action => {
        if (action === 'project.open') return OK({ sessionId: 'sess-0003', projectId: 'proj-0003', name: '坏档', revision: 1, current: ref, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.snapshot.read') return OK({ snapshot: ref, transferId: 'dl-0002', length: 22, chunkSize: 64, chunks: 1 });
        if (action === 'storage.v1.snapshot.download.chunk') return OK({ offset: 0, data: Buffer.from('{"format":"not-a-doc"}', 'utf8').toString('base64'), final: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await broken.open('proj-0003');
    await assert.rejects(() => broken.download(), StorageRequestError);
});

test('R8 renderer: a download stream growing beyond the declared length is aborted and capped', async () => {
    const ref = { version: 'dsk.v1', snapshotId: 'snap-cap', projectId: 'proj-cap', revision: 1, digest: 'd'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
    const calls: string[] = [];
    const controller = new ManagedProjectController((async action => {
        calls.push(action);
        if (action === 'project.open') return OK({ sessionId: 'sess-cap', projectId: 'proj-cap', name: '限额', revision: 1, current: ref, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.snapshot.read') return OK({ snapshot: ref, transferId: 'dl-cap', length: 16, chunkSize: 64, chunks: 1 });
        if (action === 'storage.v1.snapshot.download.chunk') {
            const served = calls.filter(name => name === 'storage.v1.snapshot.download.chunk').length - 1;
            return OK({ offset: served * 64, data: Buffer.alloc(64, 0x41).toString('base64'), final: false });
        }
        if (action === 'storage.v1.transfer.abort') return OK({ aborted: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-cap');
    await assert.rejects(() => controller.download(), (error: StorageRequestError) => error.reason === 'transfer-limit');
    assert.ok(calls.includes('storage.v1.transfer.abort'), 'the runaway download must be aborted on the wire');
});

test('capture/restoreBinding keeps the original session usable after a failed switch', async () => {
    const binding = { sessionId: 'sess-0001', projectId: 'proj-0001', projectName: '原项目', revision: 2, current: null, leaseOwned: true };
    const controller = new ManagedProjectController((async action => {
        assert.equal(action, 'storage.v1.project.close');
        return OK({ closed: true });
    }) as DskCaller);
    controller.restoreBinding(binding);
    assert.equal(controller.managedActive, false, 'binding alone does not confirm managed identity');
    await controller.closeSessionById('sess-9999');
    assert.equal(controller.sessionId, 'sess-0001', 'closing another session keeps the binding');
    assert.deepEqual(controller.capture(), binding);
});

test('leave clears the identity; activate requires an explicit success reply', async () => {
    const controller = new ManagedProjectController((async action => {
        if (action === 'project.open') return OK({ sessionId: 'sess-0001', projectId: 'proj-0001', name: '身份', revision: 0, current: null, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: 'sess-0001', projectId: 'proj-0001' });
        if (action === 'storage.v1.session.leave') return OK({ mode: 'unmanaged' });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-0001');
    assert.equal(controller.managedActive, false);
    await controller.activate();
    assert.equal(controller.managedActive, true);
    await controller.leave();
    assert.equal(controller.identity, 'unmanaged');
    assert.equal(controller.managedActive, false);
    assert.equal(controller.sessionId, null);
});

// --- Recovery autosave gate -------------------------------------------------------------------

test('managed mode disables recovery writes; unmanaged keeps them; drain settles in-flight writes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let managed = true;
    let writes = 0;
    const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    const queue = new RecoveryAutosave(async () => { writes++; return true; }, () => {}, () => {}, 10, () => !managed);
    queue.request(); queue.request();
    t.mock.timers.tick(10); await settle();
    assert.equal(writes, 0, 'managed sessions must not write legacy recovery');
    managed = false;
    queue.request();
    t.mock.timers.tick(10); await settle();
    assert.equal(writes, 1, 'unmanaged keeps the original recovery behavior');
    // Drain cancels the pending timer and settles the in-flight write.
    let release!: () => void;
    const slow = new RecoveryAutosave(async () => { await new Promise<void>(resolve => { release = resolve; }); writes++; return true; }, () => {}, () => {}, 10);
    slow.request();
    t.mock.timers.tick(10); await settle();
    let done = false;
    const drained = slow.drain().then(() => { done = true; });
    await settle();
    assert.equal(done, false, 'drain waits for the in-flight write');
    release();
    await drained;
    assert.equal(writes, 2);
});

// --- REWORK-2 CP2 named red tests (F08/F09/F10): red against the unfixed renderer -------------

test('REWORK2 F08 red: open stages a candidate and must not touch the active binding', async () => {
    const openedSessions: string[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            openedSessions.push(payload.projectId);
            if (payload.projectId === 'proj-a') return OK({ sessionId: 'sess-a', projectId: 'proj-a', name: 'A', revision: 2, current: null, leaseOwned: true, leaseBusy: false });
            return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: 'B', revision: 5, current: null, leaseOwned: true, leaseBusy: false });
        }
        if (action === 'storage.v1.snapshot.read') {
            const payload = data as { sessionId: string };
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('候选')));
            return OK({ snapshot: { version: 'dsk.v1', snapshotId: 'snap-x', projectId: payload.sessionId === 'sess-b' ? 'proj-b' : 'proj-a', revision: 1, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' }, transferId: `dl-${payload.sessionId}`, length: bytes.length, chunkSize: 65536, chunks: 1 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('候选')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId, projectId: 'proj-b' });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    // Bind A as the ACTIVE session, then stage an open of B.
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: 'A', revision: 2, current: null, leaseOwned: true });
    controller.identity = 'managed';
    await controller.open('proj-b');
    assert.equal(controller.sessionId, 'sess-a', 'the active binding must survive a staged open');
    assert.equal(controller.projectId, 'proj-a');
    assert.equal(controller.revision, 2);
    const { snapshot } = await controller.download();
    assert.equal(snapshot.projectId, 'proj-b', 'the download must target the candidate session');
    await controller.activate();
    assert.equal(controller.sessionId, 'sess-b', 'activate promotes the candidate to active');
    assert.equal(controller.revision, 5);
    assert.equal(controller.identity, 'managed');
});

test('REWORK2 F08 red: a failed create must leave the active binding alone (no restore dance needed)', async () => {
    const controller = new ManagedProjectController((async action => {
        if (action === 'project.create') return FAIL('io-failure', '创建失败');
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: 'A', revision: 1, current: null, leaseOwned: true });
    controller.identity = 'managed';
    await assert.rejects(() => controller.create('B'));
    assert.equal(controller.candidate, null, 'a failed create leaves no candidate');
    assert.equal(controller.sessionId, 'sess-a', 'the active binding is untouched');
});

test('REWORK2 F09 red: same-project reopen reuses the active session without closing it', async () => {
    const actions: string[] = [];
    const controller = new ManagedProjectController((async action => {
        actions.push(action);
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: 'A', revision: 3, current: null, leaseOwned: true });
    controller.identity = 'managed';
    const reuse = controller.reuseActiveSession('proj-a');
    assert.ok(reuse, 'a valid active session on the same project must be reusable');
    assert.equal(reuse!.sessionId, 'sess-a');
    assert.equal(controller.reuseActiveSession('proj-other'), null, 'a different project is not reusable');
    controller.leaseOwned = false;
    assert.equal(controller.reuseActiveSession('proj-a'), null, 'a lost lease is not reusable');
    assert.ok(!actions.includes('storage.v1.project.close'), 'reuse must not close anything');
});

test('REWORK2 F08 red: an unconfirmed managed state must not snapshot-write and keeps dirty', async () => {
    const harness = makeSaveHarness({ status: 'saved', snapshot: { version: 'dsk.v1' }, revision: 6 });
    (harness.managed as unknown as { saveSnapshot: () => Promise<unknown> }).saveSnapshot = async () => {
        throw Error('saveSnapshot must not be called while unconfirmed');
    };
    (harness.managed as unknown as { unconfirmed: boolean }).unconfirmed = true;
    assert.equal(await saveProjectFile(harness.ctx), false);
    assert.equal(harness.ctx.dirty, true, 'an unconfirmed state must not clear dirty');
});

test('R4 switch protocol: a refused dirty confirmation cancels before any drain or leave', async () => {
    let confirmReason = '', drains = 0, leaves = 0;
    const decision = await leaveManagedBeforeSwitch({
        managedActive: true, dirty: true,
        confirmDiscard: async reason => { confirmReason = reason; return false; },
        drainAutosave: async () => { drains++; },
        leave: async () => { leaves++; },
    }, '新建工程');
    assert.equal(confirmReason, '新建工程');
    assert.deepEqual(decision, { status: 'cancelled', stage: 'confirm' });
    assert.equal(drains, 0, 'a refused confirmation must not drain autosave');
    assert.equal(leaves, 0, 'a refused confirmation must not leave the session');
});

test('R4 switch protocol: an inactive session proceeds without confirmation', async () => {
    let confirms = 0, leaves = 0;
    const decision = await leaveManagedBeforeSwitch({
        managedActive: false, dirty: true,
        confirmDiscard: async () => { confirms++; return true; },
        drainAutosave: async () => { },
        leave: async () => { leaves++; },
    }, '导入新工程');
    assert.deepEqual(decision, { status: 'proceed' });
    assert.equal(confirms, 0, 'an inactive managed session needs no dirty confirmation');
    assert.equal(leaves, 0, 'an inactive managed session must not call leave');
});

test('R4 switch protocol: autosave drains before leave; a failed leave cancels with the error', async () => {
    const order: string[] = [];
    const boom = Error('storage.v1/storage-unavailable');
    const cancelled = await leaveManagedBeforeSwitch({
        managedActive: true, dirty: false,
        confirmDiscard: async () => { order.push('confirm'); return true; },
        drainAutosave: async () => { order.push('drain'); },
        leave: async () => { order.push('leave'); throw boom; },
    }, '新建工程');
    assert.deepEqual(order, ['drain', 'leave'], 'autosave must be drained before leaving');
    assert.deepEqual(cancelled, { status: 'cancelled', stage: 'leave', error: boom });
    order.length = 0;
    const proceed = await leaveManagedBeforeSwitch({
        managedActive: true, dirty: false,
        confirmDiscard: async () => true,
        drainAutosave: async () => { order.push('drain'); },
        leave: async () => { order.push('leave'); },
    }, '新建工程');
    assert.deepEqual(proceed, { status: 'proceed' });
    assert.deepEqual(order, ['drain', 'leave']);
});

// --- project-save dirty rules (minimal document/window shim, no real DOM) ---------------------

type SaveCtx = Parameters<typeof saveProjectFile>[0];
function makeSaveHarness(outcome: { status: string; reason?: string; message?: string; snapshot?: unknown; revision?: number }) {
    const managed = new ManagedProjectController(async () => ({ ok: true, data: null }));
    const statusNodes = new Map<string, { textContent: string }>();
    (globalThis as Record<string, unknown>).document = {
        querySelector: (selector: string) => statusNodes.get(selector) ?? null,
    };
    (globalThis as Record<string, unknown>).window = { directorDesktop: undefined };
    let revisionValue = 5;
    const ctx = {
        busy: false, playing: false, dirty: true, draft: null,
        get revision() { return revisionValue; },
        engine: { exporting: false, updateTimeUI() { } },
        history: { pending: null },
        managed,
        scenes: { document: () => makeDocument('保存规则') },
        toast() { },
        updateTimeUI() { },
    } as unknown as SaveCtx & { dirty: boolean };
    managed.restoreBinding({ sessionId: 'sess-0001', projectId: 'proj-0001', projectName: '规则', revision: 5, current: null, leaseOwned: true });
    managed.identity = 'managed';
    (managed as unknown as { saveSnapshot: () => Promise<unknown> }).saveSnapshot = async () => outcome;
    return {
        ctx: ctx as SaveCtx & { dirty: boolean },
        bumpRevision() { revisionValue = 6; },
        managed,
    };
}

test('managed save clears dirty only when epoch and revision are unchanged at completion', async () => {
    const clean = makeSaveHarness({ status: 'saved', snapshot: { version: 'dsk.v1' }, revision: 6 });
    assert.equal(await saveProjectFile(clean.ctx), true);
    assert.equal(clean.ctx.dirty, false, 'unchanged editor state may clear dirty');

    // Editor moved on during the save: dirty must survive even though the snapshot saved.
    const raced = makeSaveHarness({ status: 'saved', snapshot: { version: 'dsk.v1' }, revision: 6 });
    const originalSave = (raced.managed as unknown as { saveSnapshot: () => Promise<unknown> }).saveSnapshot;
    (raced.managed as unknown as { saveSnapshot: () => Promise<unknown> }).saveSnapshot = async () => {
        raced.bumpRevision(); // concurrent edit lands while the save await is pending
        return await originalSave.call(raced.managed);
    };
    assert.equal(await saveProjectFile(raced.ctx), false, 'a save raced by new edits must not report a clean save');
    assert.equal(raced.ctx.dirty, true, 'later dirty state must not be cleared by the older save receipt');
});

// --- RP7 unified candidate switch ---------------------------------------------------------------
// Named counterexamples for the unified managed-candidate switch protocol. The new protocol
// surface (switchManagedCandidate / adoptDownloadedSnapshot and the controller receipt scoping)
// is loaded defensively so every test fails on its own assertion against the unfixed renderer
// instead of breaking the whole file with a missing static export.

interface SwitchPortsShape {
    revision(): number;
    dirty(): boolean;
    editorBusy(): boolean;
    confirmDiscard(reason: string): Promise<boolean>;
    drain(): Promise<void>;
    prepare(document: SceneDocument): Promise<void>;
    apply(document: SceneDocument): void;
    markClean(): void;
    notify(message: string, error?: boolean): void;
}
type SwitchResult = { status: 'committed'; revision: number; reused: boolean }
    | { status: 'cancelled-confirm' } | { status: 'cancelled-changed' }
    | { status: 'failed'; error: unknown } | { status: 'unconfirmed'; error: unknown };
type SwitchFn = (managed: ManagedProjectController, projectId: string, name: string,
    ports: SwitchPortsShape, options?: { reason?: string; confirm?: boolean; startup?: boolean }) => Promise<SwitchResult>;

async function loadSwitch(): Promise<SwitchFn> {
    const mod = await import('../src/editor/managed-project.ts') as { switchManagedCandidate?: unknown };
    assert.equal(typeof mod.switchManagedCandidate, 'function', 'RP7: switchManagedCandidate export missing');
    return mod.switchManagedCandidate as SwitchFn;
}

async function flushMicrotasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

const ref = (snapshotId: string, revision: number, projectId: string) =>
    ({ version: 'dsk.v1', snapshotId, projectId, revision, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' });

interface WireCall { action: string; data: Record<string, unknown> }

function makeSwitchHarness() {
    const calls = { confirm: 0, drain: 0, prepare: 0, apply: 0, clean: 0 };
    const notes: string[] = [];
    let revisionValue = 0;
    let dirtyValue = false;
    const ports: SwitchPortsShape = {
        revision: () => revisionValue,
        dirty: () => dirtyValue,
        editorBusy: () => false,
        confirmDiscard: async () => { calls.confirm += 1; return true; },
        drain: async () => { calls.drain += 1; },
        prepare: async () => { calls.prepare += 1; },
        apply: () => { calls.apply += 1; },
        markClean: () => { calls.clean += 1; dirtyValue = false; },
        notify: (message: string) => { notes.push(message); },
    };
    return {
        ports, calls, notes,
        bump: (value: number) => { revisionValue = value; },
        setDirty: (value: boolean) => { dirtyValue = value; },
        revision: () => revisionValue,
    };
}

test('RP7-A8 red: saveSnapshot refuses at the controller entry while unconfirmed (no wire, no revision change)', async () => {
    const actions: string[] = [];
    const controller = new ManagedProjectController((async action => {
        actions.push(action);
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-u', declaredLength: 4, chunkSize: 1024 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-u', 6, 'proj-u'), revision: 6 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-u', projectId: 'proj-u', projectName: '未确认', revision: 5, current: null, leaseOwned: true });
    controller.identity = 'managed';
    controller.unconfirmed = true;
    const outcome = await controller.saveSnapshot(makeDocument('未确认'));
    assert.equal(outcome.status, 'failed', 'the controller itself must refuse the unconfirmed save');
    assert.equal((outcome as { reason: string }).reason, 'unconfirmed');
    assert.deepEqual(actions, [], 'an unconfirmed save must not reach the wire (no upload.begin)');
    assert.equal(controller.revision, 5, 'the refused save must not change revision');
    assert.equal(controller.current, null, 'the refused save must not change current');
    // An identity change alone must not lift the refusal (RP7-A9 coupling).
    controller.identity = 'unmanaged';
    const flipped = await controller.saveSnapshot(makeDocument('未确认'));
    assert.equal((flipped as { reason: string }).reason, 'unconfirmed', 'identity changes cannot bypass the block');
});

test('RP7-A3 red: a late save receipt only updates its own target, never a candidate staged mid-save', async () => {
    const document = makeDocument('迟到');
    const bytes = new TextEncoder().encode(canonicalJson(document));
    let releaseCommit!: (reply: DskReply) => void;
    const commitGate = new Promise<DskReply>(resolve => { releaseCommit = resolve; });
    const controller = new ManagedProjectController((async (action, data) => {
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            if (payload.projectId === 'proj-a') return OK({ sessionId: 'sess-a', projectId: 'proj-a', name: '甲', revision: 1, current: null, leaseOwned: true, leaseBusy: false });
            return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 4, current: null, leaseOwned: true, leaseBusy: false });
        }
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-l', declaredLength: bytes.length, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: bytes.length });
        if (action === 'storage.v1.upload.commit') return commitGate;
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await controller.open('proj-a');
    await controller.activate(); // active = A, candidate cleared
    const saving = controller.saveSnapshot(document); // targets the active session A
    await flushMicrotasks(); // let begin/chunks run; the commit receipt is gated
    await controller.open('proj-b'); // stages candidate B while the save is in flight
    releaseCommit(OK({ snapshot: ref('snap-late', 2, 'proj-a'), revision: 2 }));
    const outcome = await saving;
    assert.equal(outcome.status, 'saved');
    assert.equal(controller.candidate?.sessionId, 'sess-b');
    assert.equal(controller.candidate?.revision, 4, 'the late receipt must not write into the new candidate');
    assert.equal(controller.candidate?.current, null, 'the late receipt must not give the new candidate a snapshot');
    assert.equal(controller.revision, 1, 'the late receipt must not update the active binding once another candidate owns the stage');
    assert.equal(controller.current, null);
});

test('RP7-A3 red: a late activate receipt must not promote anything after its candidate vanished', async () => {
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    const controller = new ManagedProjectController((async action => {
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 4, current: null, leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') return activateGate;
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 1, current: null, leaseOwned: true });
    controller.identity = 'managed';
    await controller.open('proj-b');
    const activating = controller.activate();
    await controller.closeSessionById('sess-b'); // another flow cleans the staged candidate mid-activation
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    await assert.rejects(() => activating, (error: StorageRequestError) => error.reason === 'switch-superseded',
        'the late receipt must refuse to promote a target it no longer owns');
    assert.equal(controller.candidate, null);
    assert.equal(controller.sessionId, 'sess-a', 'the active binding is untouched by the superseded receipt');
    assert.equal(controller.revision, 1);
    assert.equal(controller.identity, 'managed');
});

test('RP7-A1 red: state moved during the dirty confirmation cancels the switch before any candidate', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: null, leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.setDirty(true);
    let releaseConfirm!: (value: boolean) => void;
    harness.ports.confirmDiscard = async () => {
        harness.calls.confirm += 1;
        return await new Promise<boolean>(resolve => { releaseConfirm = resolve; });
    };
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await Promise.resolve(); await Promise.resolve(); // let the confirmation await start
    harness.bump(3); // the editor moved on while the confirmation was pending
    releaseConfirm(true);
    const result = await switching;
    assert.deepEqual(result, { status: 'cancelled-changed' });
    assert.equal(harness.calls.confirm, 1);
    assert.deepEqual(wire, [], 'a switch whose state changed during confirmation must not touch the wire');
    assert.equal(controller.candidate, null);
});

test('RP7-A2 red: a refused dirty confirmation confirms exactly once with zero candidate/wire/binding effects', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const binding = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: null, leaseOwned: true };
    controller.restoreBinding(binding);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.setDirty(true);
    harness.ports.confirmDiscard = async () => { harness.calls.confirm += 1; return false; };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.deepEqual(result, { status: 'cancelled-confirm' });
    assert.equal(harness.calls.confirm, 1, 'exactly one confirmation per user action');
    assert.deepEqual(wire, [], 'a refused confirmation must not touch the wire');
    assert.equal(controller.candidate, null, 'a refused confirmation must not stage a candidate');
    assert.deepEqual(controller.capture(), binding, 'the old binding is untouched');
    assert.equal(controller.identity, 'managed', 'the persisted identity choice is untouched');
});

test('RP7-A2 red: one committed switch confirms once, opens once, activates once and applies once', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            if (payload.projectId === 'proj-a') return OK({ sessionId: 'sess-a', projectId: 'proj-a', name: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true, leaseBusy: false });
            return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        }
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const payload = data as { sessionId: string };
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument(payload.sessionId === 'sess-b' ? '乙档' : '甲档')));
            return OK({ snapshot: payload.sessionId === 'sess-b' ? ref('snap-b', 5, 'proj-b') : ref('snap-a', 2, 'proj-a'), transferId: `dl-${payload.sessionId}`, length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.setDirty(true);
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.deepEqual(result, { status: 'committed', revision: 5, reused: false });
    assert.equal(harness.calls.confirm, 1, 'exactly one dirty confirmation per action');
    assert.equal(harness.calls.apply, 1, 'the document is applied exactly once through the RP6 port');
    assert.equal(harness.calls.clean, 1, 'dirty is cleared exactly once after the full success');
    assert.equal(wire.filter(call => call.action === 'project.open').length, 1);
    assert.equal(wire.filter(call => call.action === 'storage.v1.session.activate').length, 1, 'exactly one persisted-choice activation');
    const promoted = wire.find(call => call.action === 'storage.v1.session.activate');
    assert.equal((promoted!.data as { sessionId: string }).sessionId, 'sess-b');
    assert.equal(controller.sessionId, 'sess-b');
    assert.equal(controller.identity, 'managed');
    const released = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.equal(released.length, 1, 'only the previous session is released after the full success');
    assert.equal((released[0].data as { sessionId: string }).sessionId, 'sess-a');
});

test('RP7-A4 red: a prepare failure before activation changes nothing but this run\'s candidate', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const binding = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true };
    controller.restoreBinding(binding);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.setDirty(true);
    harness.ports.prepare = async () => { harness.calls.prepare += 1; throw Error('模型资源加载失败'); };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'failed');
    assert.equal((result as { error: unknown }).error instanceof Error
        && ((result as { error: Error }).error as Error).message, '模型资源加载失败');
    assert.equal(harness.calls.apply, 0, 'a failed preparation never reaches the document apply');
    assert.equal(harness.calls.clean, 0, 'a failed preparation never clears dirty');
    assert.equal(harness.ports.dirty(), true, 'the dirty flag is untouched');
    assert.deepEqual(controller.capture(), binding, 'document binding, revision and lease are unchanged');
    assert.equal(controller.identity, 'managed', 'the persisted identity choice is unchanged');
    assert.equal(controller.candidate, null, 'only this run\'s candidate was cleaned');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b'],
        'exactly the staged candidate session is closed');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.activate'), 'no persisted-choice change');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.leave'), 'no persisted-choice change');
});

test('RP7-A5 red: post-activate apply failure compensates the persisted choice and cleans the candidate', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const binding = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true };
    controller.restoreBinding(binding);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'failed');
    assert.equal(controller.sessionId, 'sess-a', 'the compensation restored the previous managed binding');
    assert.equal(controller.revision, 2, 'the previous revision is restored');
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.unconfirmed, false, 'a successful compensation does not leave an unconfirmed state');
    assert.equal(controller.candidate, null);
    const actions = wire.map(call => call.action);
    assert.equal(actions.filter(name => name === 'storage.v1.session.activate').length, 2, 'commit + compensation');
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.equal((activations[0].data as { sessionId: string }).sessionId, 'sess-b');
    assert.equal((activations[1].data as { sessionId: string }).sessionId, 'sess-a', 'the persisted choice is compensated back');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b'],
        'only the failed candidate session is closed after compensation');
});

test('RP7-A5 red: a failed compensation leaves the explicit unconfirmed state instead of pretending recovery', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (payload.sessionId === 'sess-b') return OK({ mode: 'managed', sessionId: 'sess-b' });
            return FAIL('storage-unavailable', '补偿失败');
        }
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'unconfirmed', 'the switch must report the failed compensation instead of a plain failure');
    assert.equal(controller.unconfirmed, true, 'the controller enters the explicit unconfirmed state');
    assert.equal(controller.sessionId, 'sess-b', 'the promoted binding stays (no honest restore was possible)');
    assert.equal(controller.candidate, null);
    assert.ok(!wire.some(call => call.action === 'storage.v1.project.close'),
        'the session the persisted choice points at must not be closed');
});

test('RP7-A6 red: a same-project reopen reuses the session, adopts the downloaded revision and never activates', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open' || action === 'project.create') throw Error('the reopen must not open or create a session');
        if (action === 'storage.v1.session.activate' || action === 'storage.v1.session.leave' || action === 'storage.v1.project.close') throw Error('the reopen must not change sessions or the persisted choice');
        if (action === 'storage.v1.snapshot.read') {
            // The library is one revision ahead (an uncertain save landed): the download must win.
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档第二版')));
            return OK({ snapshot: ref('snap-a2', 2, 'proj-a'), transferId: 'dl-sess-a', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档第二版')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 1, current: ref('snap-a1', 1, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.setDirty(true);
    const result = await switchManagedCandidate(controller, 'proj-a', '甲', harness.ports, { reason: '重开当前项目' });
    assert.deepEqual(result, { status: 'committed', revision: 2, reused: true }, 'the reopen adopts the DOWNLOADED revision');
    assert.equal(controller.revision, 2, 'the stale pre-reopen revision must not survive');
    const adopt = (controller as unknown as { current: { snapshotId: string } }).current;
    assert.equal(adopt.snapshotId, 'snap-a2', 'the adopted SnapshotRef is the downloaded one');
    assert.equal(controller.sessionId, 'sess-a', 'the same session is reused');
    assert.equal(harness.calls.confirm, 1, 'exactly one dirty confirmation for the reopen action');
    assert.equal(harness.calls.clean, 1);
    assert.ok(wire.every(call => ['storage.v1.snapshot.read', 'storage.v1.snapshot.download.chunk'].includes(call.action)),
        'the reopen only reads: no open/create/activate/leave/close traffic');
});

test('RP7-A6 red: a failed reopen apply keeps the old revision, current and the reused session open', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档第二版')));
            return OK({ snapshot: ref('snap-a2', 2, 'proj-a'), transferId: 'dl-sess-a', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档第二版')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const binding = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 1, current: ref('snap-a1', 1, 'proj-a'), leaseOwned: true };
    controller.restoreBinding(binding);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-a', '甲', harness.ports, { reason: '重开当前项目' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(controller.capture(), binding, 'the old revision/current/binding stay exact');
    assert.equal(controller.unconfirmed, false, 'nothing persisted changed, so no unconfirmed state');
    assert.ok(!wire.some(call => ['storage.v1.session.activate', 'storage.v1.session.leave', 'storage.v1.project.close'].includes(call.action)),
        'a failed reopen must not close the reused session or touch the persisted choice');
});

test('RP7-A9 red: compensation success and identity changes cannot lift the unconfirmed block or the WriteGate', async () => {
    const switchManagedCandidate = await loadSwitch();
    const { WriteGate } = await import('../src/scenes/document-apply.ts') as { WriteGate: new () => { blocked: boolean; refuse(): void; block(reason: unknown): void; clear(): void } };
    const gate = new WriteGate();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.session.leave') return OK({ mode: 'unmanaged' });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    // The RP6 writeBlocked port (main.ts) blocks the gate and marks the controller unconfirmed.
    harness.ports.apply = () => {
        harness.calls.apply += 1;
        gate.block(Error('界面重建失败'));
        controller.unconfirmed = true;
        throw Error('演示失败');
    };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'failed', 'the compensation itself succeeded');
    assert.equal(controller.unconfirmed, true, 'a successful compensation must NOT clear the write-blocked unconfirmed flag');
    assert.equal(gate.blocked, true, 'the WriteGate hard block survives the compensation');
    assert.throws(() => gate.refuse(), /整档回滚失败禁写状态/, 'the blocked editor refuses writes');
    // A retried switch cannot bypass the gate through its apply port either.
    const retried = await switchManagedCandidate(controller, 'proj-a', '甲', harness.ports, { confirm: false });
    assert.equal(retried.status, 'failed', 'the retry is refused by the gate and fails cleanly');
    // Identity changes cannot lift the unconfirmed block either.
    await controller.leave();
    assert.equal(controller.identity, 'unmanaged');
    assert.equal(controller.unconfirmed, true, 'leaving managed does not clear the unconfirmed flag');
});

test('RP7-A11 red: a failed old-session release after a committed switch stays committed and closes only the old session', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return OK({ sessionId: 'sess-b', projectId: 'proj-b', name: '乙', revision: 5, current: ref('snap-b', 5, 'proj-b'), leaseOwned: true, leaseBusy: false });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') {
            const payload = data as { sessionId: string };
            if (payload.sessionId === 'sess-a') return FAIL('io-failure', '关闭失败');
            return OK({ closed: true });
        }
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'committed', 'a failed cleanup must not turn the committed switch into an uncommitted one');
    assert.equal(controller.sessionId, 'sess-b');
    assert.equal(harness.calls.clean, 1, 'the committed switch still cleared dirty exactly once');
    assert.ok(harness.notes.some(message => message.includes('原会话释放失败')), 'the release failure is reported');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-a'],
        'only the old session release was attempted, exactly once');
});

test('uncertain commits and failures keep dirty; export copies never clear managed dirty', async () => {
    const uncertain = makeSaveHarness({ status: 'outcome-unknown', message: '提交结果不确定' });
    assert.equal(await saveProjectFile(uncertain.ctx), false);
    assert.equal(uncertain.ctx.dirty, true, 'uncertain outcome keeps dirty and blocks silent retries');
    const failed = makeSaveHarness({ status: 'failed', reason: 'lease-busy', message: '租约被占用' });
    assert.equal(await saveProjectFile(failed.ctx), false);
    assert.equal(failed.ctx.dirty, true);
    // Export copy path without the desktop bridge: dirty state survives regardless.
    const copy = makeSaveHarness({ status: 'saved' });
    assert.equal(await exportProjectCopy(copy.ctx as unknown as Parameters<typeof exportProjectCopy>[0]), false);
    assert.equal(copy.ctx.dirty, true, 'a .director copy is not a managed save');
});

// --- RP7 REWORK (F01–F05): focused counterexamples for the review findings ---------------------

interface CreatePortsShape {
    revision(): number;
    document(): SceneDocument;
    markClean(): void;
    notify(message: string, error?: boolean): void;
}
type CreateResult = { status: 'committed'; revision: number; snapshot: { snapshotId: string; revision: number; projectId: string } }
    | { status: 'save-unknown' } | { status: 'save-failed'; message: string } | { status: 'stale-saved' }
    | { status: 'failed'; error: unknown } | { status: 'unconfirmed'; error: unknown };
type CreateFn = (managed: ManagedProjectController, name: string, ports: CreatePortsShape) => Promise<CreateResult>;

async function loadCreate(): Promise<CreateFn> {
    const mod = await import('../src/editor/managed-project.ts') as { createManagedFromCurrent?: unknown };
    assert.equal(typeof mod.createManagedFromCurrent, 'function', 'RP7/F01: createManagedFromCurrent export missing');
    return mod.createManagedFromCurrent as CreateFn;
}

/** Wait (bounded, deterministically) until the scripted wire saw the given action. */
async function untilWire(wire: WireCall[], action: string) {
    for (let i = 0; i < 500 && !wire.some(call => call.action === action); i++) await Promise.resolve();
    assert.ok(wire.some(call => call.action === action), `the flow never reached ${action}`);
}

const sessionReply = (sessionId: string, projectId: string, name: string, revision: number, current: unknown) =>
    OK({ sessionId, projectId, name, revision, current, leaseOwned: true, leaseBusy: false });

// F02: a startup apply failure must close THIS candidate explicitly, never session.leave, and
// keep the persisted managed choice; a bare resetSession() used to forget the live session.
test('RP7 F02 red: a startup apply failure closes only this candidate session, never leaves, and keeps the managed choice', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    // F02: a tiny persisted-choice model — only session.leave flips it to unmanaged, so the
    // post-failure bootstrap proves the persisted managed project survived untouched.
    let persistedMode: 'managed' | 'unmanaged' = 'managed';
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'storage.v1.session.bootstrap') return OK({ mode: persistedMode, projectId: 'proj-start', name: '启动' });
        if (action === 'project.open') return sessionReply('sess-start', 'proj-start', '启动', 3, ref('snap-start', 3, 'proj-start'));
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.session.leave') { persistedMode = 'unmanaged'; return OK({ mode: 'unmanaged' }); }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('启动档')));
            return OK({ snapshot: ref('snap-start', 3, 'proj-start'), transferId: 'dl-start', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('启动档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.identity = 'none'; // startup: nothing active yet, the persisted choice is managed
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-start', '启动', harness.ports, { confirm: false, startup: true });
    assert.equal(result.status, 'failed');
    assert.equal(harness.calls.apply, 1, 'the apply was attempted exactly once');
    assert.equal(harness.calls.clean, 0, 'a failed startup restore never clears dirty');
    const actions = wire.map(call => call.action);
    assert.equal(actions.filter(name => name === 'storage.v1.session.activate').length, 1, 'exactly the commit activation');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-start'],
        'THIS run\'s candidate session is explicitly closed instead of being forgotten by a bare reset');
    assert.ok(!actions.includes('storage.v1.session.leave'), 'the persisted managed choice is never left');
    assert.equal(controller.sessionId, null, 'the local binding is dropped after the successful close');
    assert.equal(controller.identity, 'managed', 'the persisted choice stays managed (never flipped to unmanaged)');
    assert.equal(controller.candidate, null);
    assert.equal(controller.unconfirmed, false, 'a cleanly closed startup failure needs no unconfirmed state');
    // F02: the persisted choice still resolves to the ORIGINAL managed project — legacy
    // recovery stays untouched territory and the next startup retries the same project.
    const boot = await controller.bootstrap();
    assert.ok(boot, 'bootstrap returns the persisted shape');
    assert.equal(boot.mode, 'managed', 'bootstrap still reports the managed mode after the failed startup restore');
    assert.equal(boot.projectId, 'proj-start', 'bootstrap still points at the original managed project');
    assert.equal(persistedMode, 'managed', 'no leave ever flipped the persisted choice');
});

// F02: a failed candidate close must stay traceable — binding kept, unconfirmed entered, report.
test('RP7 F02 red: a failed startup candidate close stays traceable instead of being forgotten after reset', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-start', 'proj-start', '启动', 3, ref('snap-start', 3, 'proj-start'));
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return FAIL('io-failure', '关闭失败');
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('启动档')));
            return OK({ snapshot: ref('snap-start', 3, 'proj-start'), transferId: 'dl-start', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('启动档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.identity = 'none';
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-start', '启动', harness.ports, { confirm: false, startup: true });
    assert.equal(result.status, 'failed');
    assert.ok(harness.notes.some(message => message.includes('候选会话关闭失败')), 'the dangling session is reported');
    assert.equal(controller.sessionId, 'sess-start', 'the binding is kept so the unclosed session is not forgotten');
    assert.equal(controller.unconfirmed, true, 'the controller enters the explicit unconfirmed state');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.leave'), 'the persisted managed choice is never left');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.equal(closes.length, 1, 'exactly one close attempt for this run\'s candidate');
});

// F03: state moved during the activation await must not be applied or marked clean; the already
// committed persisted choice compensates instead.
test('RP7 F03 red: a revision moved during the activation await is never applied; the committed choice compensates', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-b') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await untilWire(wire, 'storage.v1.session.activate'); // the commit activation is pending
    harness.bump(9); // the editor moved on while the activation receipt was in flight
    parked = false;
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    const result = await switching;
    assert.equal(result.status, 'failed');
    assert.ok(result.error instanceof Error && /切换期间工程状态已变化/.test(result.error.message),
        'the post-activation race is reported as a moved state');
    assert.equal(harness.calls.apply, 0, 'a state moved during the activation await is never applied');
    assert.equal(harness.calls.clean, 0, 'a raced switch never clears dirty');
    assert.equal(controller.sessionId, 'sess-a', 'the committed persisted choice was compensated back');
    assert.equal(controller.revision, 2);
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.candidate, null);
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.deepEqual(activations.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b', 'sess-a'],
        'commit activation + compensation activation, nothing else');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b'],
        'only the failed candidate session is closed');
});

// F03: the same protection for the editor epoch.
test('RP7 F03 red: an epoch moved during the activation await is never applied and compensates', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseActivate: ((reply: DskReply) => void) | undefined;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-b') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await untilWire(wire, 'storage.v1.session.activate');
    controller.epoch += 1; // another whole-document apply landed while the receipt was pending
    parked = false;
    releaseActivate!(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    const result = await switching;
    assert.equal(result.status, 'failed');
    assert.equal(harness.calls.apply, 0);
    assert.equal(harness.calls.clean, 0);
    assert.equal(controller.sessionId, 'sess-a', 'the committed choice was compensated back');
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.deepEqual(activations.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b', 'sess-a']);
});

// F04: the open/create receipt races — a second operation must be refused while one is pending.
test('RP7 F04 red: a second open is refused while the first open receipt is still in flight', async () => {
    let releaseOpen!: (reply: DskReply) => void;
    const openGate = new Promise<DskReply>(resolve => { releaseOpen = resolve; });
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            return payload.projectId === 'proj-a' ? openGate : sessionReply('sess-b', 'proj-b', '乙', 1, null);
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const opening = controller.open('proj-a');
    await assert.rejects(() => controller.open('proj-b'), (error: StorageRequestError) => error.reason === 'switch-in-flight',
        'the second open must be refused synchronously instead of racing for the candidate stage');
    assert.deepEqual(wire.map(call => call.action), ['project.open'], 'the refused open never reached the wire');
    releaseOpen(sessionReply('sess-a', 'proj-a', '甲', 2, null));
    const session = await opening;
    assert.equal(session.sessionId, 'sess-a');
    assert.equal(controller.candidate?.sessionId, 'sess-a', 'the receipt still stages its own candidate');
    assert.deepEqual(wire.filter(call => call.action === 'project.open').length, 1, 'exactly one open on the wire');
});

// F04: open/create mutual exclusion too.
test('RP7 F04 red: a create is refused while an open receipt is pending; the late open receipt still stages its own candidate', async () => {
    let releaseOpen!: (reply: DskReply) => void;
    const openGate = new Promise<DskReply>(resolve => { releaseOpen = resolve; });
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return openGate;
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新', 0, null);
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const opening = controller.open('proj-a');
    await assert.rejects(() => controller.create('新'), (error: StorageRequestError) => error.reason === 'switch-in-flight');
    assert.ok(!wire.some(call => call.action === 'project.create'), 'the refused create never reached the wire');
    releaseOpen(sessionReply('sess-a', 'proj-a', '甲', 2, null));
    await opening;
    assert.equal(controller.candidate?.sessionId, 'sess-a', 'the earlier receipt is not overwritten by a later one');
    // F04: a SETTLED but unresolved candidate still owns the controller — a later create must
    // stay refused (its receipt would overwrite the staged candidate), and only after the
    // staged candidate is resolved does the next create proceed.
    await assert.rejects(() => controller.create('新'), (error: StorageRequestError) => error.reason === 'switch-in-flight',
        'a staged candidate still owns the controller after its receipt settled');
    assert.ok(!wire.some(call => call.action === 'project.create'), 'the refused create still never reached the wire');
    assert.equal(controller.candidate?.sessionId, 'sess-a', 'the staged candidate was not replaced by the refusal');
    await controller.closeSessionById('sess-a'); // resolve (clean) the staged candidate
    const created = await controller.create('新');
    assert.equal(created.sessionId, 'sess-new');
    assert.equal(controller.candidate?.sessionId, 'sess-new', 'the new candidate stages once the old one was resolved');
});

// F04: a candidate cleared mid-switch must not count as "still owned"; no apply, no double close.
test('RP7 F04 red: a candidate cleared during preparation aborts the switch without applying or double-closing', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const binding = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true };
    controller.restoreBinding(binding);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    harness.ports.prepare = async () => {
        harness.calls.prepare += 1;
        await controller.closeSessionById('sess-b'); // another flow cleans the staged candidate mid-prepare
    };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'failed');
    assert.ok(result.error instanceof Error && /切换期间工程状态已变化/.test(result.error.message),
        'the lost candidate must abort the switch, not count as still owned');
    assert.equal(harness.calls.apply, 0);
    assert.equal(harness.calls.clean, 0);
    assert.deepEqual(controller.capture(), binding, 'the active binding is untouched');
    assert.equal(controller.candidate, null);
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.activate'),
        'no activation happens once the candidate was lost');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.leave'));
    const closes = wire.filter(call => call.action === 'storage.v1.project.close');
    assert.deepEqual(closes.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b'],
        'exactly one close: the other path\'s own cleanup — the switch must not close it again');
});

// F05: a pre-existing unconfirmed state survives activation and a SUCCESSFUL compensation; only
// a fully applied reopen lifts it.
test('RP7 F05 red: a pre-existing unconfirmed state survives activation and successful compensation until a full reopen', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            if (payload.projectId === 'proj-b') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
            return sessionReply('sess-a', 'proj-a', '甲', 2, ref('snap-a', 2, 'proj-a'));
        }
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('下载档')));
            return OK({ snapshot: ref('snap-dl', 2, 'proj-a'), transferId: 'dl-sess-a', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('下载档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-f05', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-f05', 3, 'proj-a'), revision: 3 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    controller.unconfirmed = true; // a previous switch left the state explicitly unconfirmed
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; throw Error('演示失败'); };
    const result = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    assert.equal(result.status, 'failed', 'the compensation itself succeeded');
    assert.equal(controller.unconfirmed, true,
        'activation + successful compensation must NOT lift a pre-existing unconfirmed block (F05)');
    // The save stays refused at the controller entry: no upload ever begins.
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal(refused.status, 'failed');
    assert.equal((refused as { reason: string }).reason, 'unconfirmed');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'), 'no upload.begin while unconfirmed');
    // Only a FULLY successful reopen (document applied + snapshot adopted) ends the state.
    const recovery = makeSwitchHarness();
    const reopened = await switchManagedCandidate(controller, 'proj-a', '甲', recovery.ports, { confirm: false });
    assert.equal(reopened.status, 'committed', 'the same-project reopen fully succeeds');
    assert.equal((reopened as { reused?: boolean }).reused, true);
    assert.equal(controller.unconfirmed, false, 'the full reopen lifted the recoverable unconfirmed state');
    const saved = await controller.saveSnapshot(makeDocument('恢复后保存'));
    assert.equal(saved.status, 'saved');
    assert.ok(wire.some(call => call.action === 'storage.v1.upload.begin'), 'saves reach the wire again only after the full success');
});

// F05: a write-blocked editor refuses the cross-project retry, and the create/save entries stay
// refused — no identity change or activation side effect can unlock it.
test('RP7 F05 red: a write-blocked retry fails cleanly and the create/save entries stay refused', async () => {
    const switchManagedCandidate = await loadSwitch();
    const createManagedFromCurrent = await loadCreate();
    const { WriteGate } = await import('../src/scenes/document-apply.ts') as { WriteGate: new () => { blocked: boolean; refuse(): void; block(reason: unknown): void } };
    const gate = new WriteGate();
    gate.block(Error('界面重建失败')); // the editor is hard write-blocked from the start
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新项目', 0, null);
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    controller.unconfirmed = true; // mirrors main.ts: writeBlocked also marks the controller unconfirmed
    // Cross-project retry: the gate refuses the apply, the switch fails cleanly (pre-commit).
    const harness = makeSwitchHarness();
    harness.ports.apply = () => { harness.calls.apply += 1; gate.refuse(); };
    const retried = await switchManagedCandidate(controller, 'proj-b', '乙', harness.ports, { confirm: false });
    assert.equal(retried.status, 'failed', 'the gate refuses the retried switch apply');
    assert.equal(gate.blocked, true, 'the WriteGate block survives');
    assert.equal(controller.unconfirmed, true, 'no path lifted the unconfirmed state');
    assert.deepEqual(controller.capture(), { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true },
        'the binding is unchanged after the refused retry');
    // Create entry: refused too — the candidate is staged and released, but no upload ever begins.
    const notes: string[] = [];
    const wireBeforeCreate = wire.length;
    const createResult = await createManagedFromCurrent(controller, '新项目', {
        revision: () => 0,
        document: () => makeDocument('新项目'),
        markClean: () => { },
        notify: message => { notes.push(message); },
    });
    assert.equal(createResult.status, 'save-failed', 'the create is refused by the unconfirmed save entry');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'), 'no upload.begin anywhere on the refused paths');
    assert.equal(controller.candidate, null, 'the refused create released only its own candidate');
    // F05: scope to the create phase — the earlier refused SWITCH already closed its own
    // candidate (sess-b) during its pre-commit cleanup, which is correct and separately proven.
    assert.deepEqual(wire.slice(wireBeforeCreate).filter(call => call.action === 'storage.v1.project.close').map(call => (call.data as { sessionId: string }).sessionId), ['sess-new'],
        'only the refused create\'s candidate session was closed');
    // Save entry: still refused.
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal((refused as { reason?: string }).reason, 'unconfirmed');
});

// F01: creating from a PLAIN session must commit — the new sessionId always differs from the
// (null) previous, so the old "binding must still equal previous" check failed every create.
test('RP7 F01 red: creating from a plain session activates exactly once without compensation and never resets the document', async () => {
    const createManagedFromCurrent = await loadCreate();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新项目', 0, null);
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-new', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-new', 1, 'proj-new'), revision: 1 });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    assert.equal(controller.identity, 'none');
    let documentReads = 0, cleans = 0;
    const notes: string[] = [];
    const result = await createManagedFromCurrent(controller, '新项目', {
        revision: () => 0,
        document: () => { documentReads += 1; return makeDocument('当前工程'); },
        markClean: () => { cleans += 1; },
        notify: message => { notes.push(message); },
    });
    assert.deepEqual(result, { status: 'committed', revision: 1, snapshot: ref('snap-new', 1, 'proj-new') });
    assert.equal(documentReads, 1, 'the document is read once for the first snapshot — never replaced or history-reset');
    assert.equal(cleans, 1, 'dirty is cleared exactly once after the full success');
    const actions = wire.map(call => call.action);
    assert.equal(actions.filter(name => name === 'storage.v1.session.activate').length, 1, 'exactly one activation');
    assert.ok(!actions.includes('storage.v1.session.leave'), 'no compensation: the plain session is never left');
    assert.ok(!actions.includes('storage.v1.project.close'), 'nothing to release without a previous session');
    assert.deepEqual(notes, [], 'a clean create reports no failure');
    assert.equal(controller.sessionId, 'sess-new');
    assert.equal(controller.projectId, 'proj-new');
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.candidate, null);
    assert.equal(controller.revision, 1, 'the promoted binding carries the first snapshot revision');
});

// F01: creating from managed A must switch to the new project exactly once and release A only
// after the full success — not require the binding to still equal A after the activation.
test('RP7 F01 red: creating from managed A switches to the new project once and releases A only after full success', async () => {
    const createManagedFromCurrent = await loadCreate();
    const wire: WireCall[] = [];
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新项目', 0, null);
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-new', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-new', 1, 'proj-new'), revision: 1 });
        if (action === 'storage.v1.session.activate') return OK({ mode: 'managed', sessionId: (data as { sessionId: string }).sessionId });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const result = await createManagedFromCurrent(controller, '新项目', {
        revision: () => 0,
        document: () => makeDocument('当前工程'),
        markClean: () => { },
        notify: () => { },
    });
    assert.deepEqual(result, { status: 'committed', revision: 1, snapshot: ref('snap-new', 1, 'proj-new') });
    const actions = wire.map(call => call.action);
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.equal(activations.length, 1, 'exactly one activation, no compensation round');
    assert.equal((activations[0].data as { sessionId: string }).sessionId, 'sess-new', 'the new project is activated');
    assert.ok(!actions.includes('storage.v1.session.leave'), 'no compensation');
    const closeIndex = wire.findIndex(call => call.action === 'storage.v1.project.close');
    const activateIndex = wire.findIndex(call => call.action === 'storage.v1.session.activate');
    assert.ok(activateIndex >= 0 && closeIndex > activateIndex, 'the old session is released only after the activation committed');
    assert.deepEqual(wire.filter(call => call.action === 'storage.v1.project.close').map(call => (call.data as { sessionId: string }).sessionId),
        ['sess-a'], 'exactly the previous session is released, after the full success');
    assert.equal(controller.sessionId, 'sess-new');
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.candidate, null);
});

// F01: a genuine epoch/revision race during the create activation still compensates.
test('RP7 F01 red: an editor race during the create activation compensates the committed choice and cleans only the candidate', async () => {
    const createManagedFromCurrent = await loadCreate();
    const wire: WireCall[] = [];
    let releaseActivate: ((reply: DskReply) => void) | undefined;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新项目', 0, null);
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-new', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-new', 1, 'proj-new'), revision: 1 });
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-new') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    let revisionValue = 0;
    let cleans = 0;
    const creating = createManagedFromCurrent(controller, '新项目', {
        revision: () => revisionValue,
        document: () => makeDocument('当前工程'),
        markClean: () => { cleans += 1; },
        notify: () => { },
    });
    await untilWire(wire, 'storage.v1.session.activate');
    revisionValue = 7; // the editor moved on while the activation receipt was in flight
    parked = false;
    releaseActivate!(OK({ mode: 'managed', sessionId: 'sess-new', projectId: 'proj-new' }));
    const result = await creating;
    assert.equal(result.status, 'failed');
    assert.ok(result.error instanceof Error && /激活后工程状态已变化/.test(result.error.message));
    assert.equal(cleans, 0, 'a raced create never clears dirty');
    assert.equal(controller.sessionId, 'sess-a', 'the committed choice was compensated back to A');
    assert.equal(controller.revision, 2);
    assert.equal(controller.identity, 'managed');
    assert.equal(controller.candidate, null);
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.deepEqual(activations.map(call => (call.data as { sessionId: string }).sessionId), ['sess-new', 'sess-a'],
        'commit activation + compensation activation');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.leave'));
    assert.deepEqual(wire.filter(call => call.action === 'storage.v1.project.close').map(call => (call.data as { sessionId: string }).sessionId),
        ['sess-new'], 'only the failed candidate session is closed; A stays open');
});

// --- RP7 REPLAN R01: a committed-but-superseded activation must compensate, never run
// uncommitted cleanup. session.activate persists the choice (setLastSession) BEFORE the ok
// receipt reaches the renderer, so a receipt arriving after the candidate was closed/replaced
// is a COMMITTED fact — the persisted choice must be restored or the state must become
// explicitly unconfirmed; it must never fall through the pre-commit failure path. -------------

// R01-B (mock half): without a previous managed binding, the compensation may only leave THIS
// operation's own committed session — never a sessionId guessed from the current candidate or
// the active binding — and a foreign candidate staged mid-flight stays intact.
test('RP7 R01: a superseded create activation leaves only this operation\'s own committed session, never a guessed sessionId', async () => {
    const createManagedFromCurrent = await loadCreate();
    const wire: WireCall[] = [];
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.create') return sessionReply('sess-new', 'proj-new', '新项目', 0, null);
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-r01b', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-new', 1, 'proj-new'), revision: 1 });
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-new') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.session.leave') {
            // Only the create's own session may be left; anything else must refuse loudly.
            const payload = data as { sessionId: string };
            return payload.sessionId === 'sess-new' ? OK({ mode: 'unmanaged' }) : FAIL('unknown-session', '存储会话不存在或已关闭');
        }
        if (action === 'project.open') return sessionReply('sess-d', 'proj-d', '丁', 1, ref('snap-d', 1, 'proj-d'));
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.identity = 'none'; // plain session: there is NO previous managed binding
    let revisionValue = 0;
    const creating = createManagedFromCurrent(controller, '新项目', {
        revision: () => revisionValue,
        document: () => makeDocument('当前工程'),
        markClean: () => { },
        notify: () => { },
    });
    await untilWire(wire, 'storage.v1.session.activate'); // the commit activation is parked
    // While the receipt is in flight (a real service has already setLastSession('proj-new')),
    // another path closes the staged candidate and a different open stages a foreign candidate.
    await controller.closeSessionById('sess-new');
    await controller.open('proj-d');
    parked = false;
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-new', projectId: 'proj-new' }));
    const result = await creating;
    assert.equal(result.status, 'failed', 'the compensation succeeded, so this is a plain failure — not unconfirmed');
    assert.equal(controller.identity, 'unmanaged',
        'the persisted choice was honestly reverted by leaving THIS operation\'s committed session');
    const leaves = wire.filter(call => call.action === 'storage.v1.session.leave');
    assert.deepEqual(leaves.map(call => (call.data as { sessionId: string }).sessionId), ['sess-new'],
        'the leave targets exactly the committed session — never a guessed candidate/binding sessionId');
    assert.equal(controller.candidate?.sessionId, 'sess-d', 'the foreign candidate staged mid-flight is not stolen');
    assert.ok(wire.filter(call => call.action === 'storage.v1.project.close')
        .every(call => (call.data as { sessionId: string }).sessionId === 'sess-new'),
        'no cleanup ever closes the foreign candidate\'s session');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.activate' && (call.data as { sessionId: string }).sessionId === 'sess-d'),
        'the foreign candidate\'s persisted choice is never touched');
});

// R01-C: when the compensation of a committed-but-superseded switch fails, the controller enters
// the explicit unconfirmed state and saveSnapshot refuses at the entry with zero upload.begin.
test('RP7 R01: a failed superseded-switch compensation leaves the explicit unconfirmed state and saveSnapshot never reaches upload.begin', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-b') return activateGate;
            if (payload.sessionId === 'sess-b') return OK({ mode: 'managed', sessionId: 'sess-b' });
            return FAIL('storage-unavailable', '补偿失败'); // restoring A fails
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-r01c', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-c', 6, 'proj-a'), revision: 6 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await untilWire(wire, 'storage.v1.session.activate'); // commit activation parked (choice = B)
    await controller.closeSessionById('sess-b'); // another path closes the candidate mid-activation
    parked = false;
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    const result = await switching;
    assert.equal(result.status, 'unconfirmed', 'the failed compensation must be reported as unconfirmed');
    assert.equal(controller.unconfirmed, true, 'the controller enters the explicit unconfirmed state');
    assert.equal(controller.identity, 'managed', 'the superseded receipt never promoted locally, so the binding was never moved');
    assert.equal(controller.sessionId, 'sess-a', 'the local binding still points at A');
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal(refused.status, 'failed', 'the unconfirmed save is refused at the controller entry');
    assert.equal((refused as { reason: string }).reason, 'unconfirmed');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'),
        'a refused save never begins an upload');
    assert.equal(controller.revision, 2, 'the refused save leaves the binding revision exact');
});

// R01-D: between the committed activation and the finished compensation, a late receipt must not
// overwrite a newer candidate/binding, must not close another operation's session and must not
// commit anything for it.
test('RP7 R01: a late activation receipt neither overwrites a newer candidate nor closes its session', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            return payload.projectId === 'proj-b'
                ? sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'))
                : sessionReply('sess-d', 'proj-d', '丁', 8, ref('snap-d', 8, 'proj-d'));
        }
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-b') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('下载档')));
            return OK({ snapshot: ref('snap-dl', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('下载档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    const bindingA = { sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true };
    controller.restoreBinding(bindingA);
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await untilWire(wire, 'storage.v1.session.activate'); // commit activation parked (choice = B)
    await controller.closeSessionById('sess-b'); // another path closes the staged candidate
    await controller.open('proj-d'); // a NEW operation stages its own candidate meanwhile
    parked = false;
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    const result = await switching;
    assert.equal(result.status, 'failed', 'the committed switch compensated back to A');
    const activations = wire.filter(call => call.action === 'storage.v1.session.activate');
    assert.deepEqual(activations.map(call => (call.data as { sessionId: string }).sessionId), ['sess-b', 'sess-a'],
        'commit activation + compensation activation — the newer candidate is never activated');
    assert.ok(wire.filter(call => call.action === 'storage.v1.project.close')
        .every(call => (call.data as { sessionId: string }).sessionId === 'sess-b'),
        'cleanup only ever targets this run\'s own session, never the newer operation\'s session');
    assert.equal(controller.candidate?.sessionId, 'sess-d', 'the newer candidate survives with its own data');
    assert.equal(controller.candidate?.revision, 8, 'the late receipt never overwrites the newer candidate');
    assert.deepEqual(controller.capture(), bindingA, 'the restored binding is exactly A');
    assert.equal(controller.identity, 'managed');
    assert.equal(harness.calls.apply, 0, 'a superseded switch never applies its stale document');
    assert.equal(harness.calls.clean, 0, 'a superseded switch never clears dirty');
    assert.ok(!wire.some(call => call.action === 'storage.v1.session.leave'),
        'a managed restore compensates by activating A, never by leaving');
});

test('RP7 R01: a late compensation receipt does not revive a closed binding over a finished newer switch', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseB!: (reply: DskReply) => void;
    let releaseCompensation!: (reply: DskReply) => void;
    const gateB = new Promise<DskReply>(resolve => { releaseB = resolve; });
    const gateCompensation = new Promise<DskReply>(resolve => { releaseCompensation = resolve; });
    let holdB = true;
    let holdCompensation = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') {
            const payload = data as { projectId: string };
            return payload.projectId === 'proj-b'
                ? sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'))
                : sessionReply('sess-d', 'proj-d', '丁', 8, ref('snap-d', 8, 'proj-d'));
        }
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (holdB && payload.sessionId === 'sess-b') return gateB;
            if (holdCompensation && payload.sessionId === 'sess-a') return gateCompensation;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const projectId = (data as { sessionId: string }).sessionId === 'sess-d' ? 'proj-d' : 'proj-b';
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument(projectId)));
            return OK({ snapshot: ref('snap-dl', projectId === 'proj-d' ? 8 : 5, projectId), transferId: 'dl-' + projectId, length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const transferId = (data as { transferId: string }).transferId;
            const projectId = transferId.endsWith('proj-d') ? 'proj-d' : 'proj-b';
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument(projectId)));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-late', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.transfer.abort') return OK({ aborted: true });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const first = makeSwitchHarness();
    let failApplyB = false;
    first.ports.apply = () => {
        if (failApplyB) throw Error('第一次应用失败');
    };
    const switchingB = switchManagedCandidate(controller, 'proj-b', '乙', first.ports, { confirm: false });
    await untilWire(wire, 'storage.v1.session.activate');
    failApplyB = true;
    holdB = false;
    releaseB(OK({ mode: 'managed', sessionId: 'sess-b' }));
    const failedB = switchingB;
    for (let i = 0; i < 50 && controller.candidate; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(controller.candidate, null, 'the failed first switch released its candidate before the newer open');
    const realOpen = controller.open.bind(controller);
    let releaseOpenD!: () => void;
    controller.open = (projectId: string) => projectId === 'proj-d'
        ? new Promise<void>(resolve => { releaseOpenD = resolve; }).then(() => realOpen(projectId))
        : realOpen(projectId);
    const second = makeSwitchHarness();
    const switchingD = switchManagedCandidate(controller, 'proj-d', '丁', second.ports, { confirm: false });
    for (let i = 0; i < 20 && typeof releaseOpenD !== 'function'; i++) await Promise.resolve();
    assert.equal(typeof releaseOpenD, 'function', 'the newer switch reached its own open');
    releaseOpenD();
    for (let i = 0; i < 20 && wire.filter(call => call.action === 'storage.v1.session.activate' && (call.data as { sessionId: string }).sessionId === 'sess-a').length < 1; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(wire.filter(call => call.action === 'storage.v1.session.activate' && (call.data as { sessionId: string }).sessionId === 'sess-a').length, 1,
        'the old operation sent its compensation before the newer switch finished');
    const doneD = await switchingD;
    assert.equal(doneD.status, 'committed', 'the newer switch finishes while the old compensation receipt is still held');
    assert.equal(controller.sessionId, 'sess-d');
    holdCompensation = false;
    releaseCompensation(OK({ mode: 'managed', sessionId: 'sess-a' }));
    const doneB = await failedB;
    assert.equal(doneB.status, 'unconfirmed', 'the late compensation cannot claim the old binding was restored');
    assert.equal(controller.sessionId, 'sess-d', 'the finished newer binding stays');
    assert.equal(controller.projectId, 'proj-d');
    assert.equal(controller.unconfirmed, true, 'the split stays explicit');
    assert.equal(controller.candidate, null);
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal(refused.status, 'failed');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'), 'the unresolved split never uploads');
    const closes = wire.filter(call => call.action === 'storage.v1.project.close').map(call => (call.data as { sessionId: string }).sessionId);
    assert.ok(closes.includes('sess-b'), 'the newer switch releases the binding it replaced');
    assert.ok(!closes.includes('sess-d'), 'the late receipt never closes the newer session');
    assert.equal(controller.revision, 8, 'the newer downloaded revision stays');
});

test('RP7 R01: a late compensation receipt does not revive a binding cleared by leave', async () => {
    const switchManagedCandidate = await loadSwitch();
    const wire: WireCall[] = [];
    let releaseB!: (reply: DskReply) => void;
    let releaseCompensation!: (reply: DskReply) => void;
    const gateB = new Promise<DskReply>(resolve => { releaseB = resolve; });
    const gateCompensation = new Promise<DskReply>(resolve => { releaseCompensation = resolve; });
    let holdB = true;
    let holdCompensation = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (holdB && payload.sessionId === 'sess-b') return gateB;
            if (holdCompensation && payload.sessionId === 'sess-a') return gateCompensation;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.session.leave') return OK({ mode: 'unmanaged' });
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-null', declaredLength: 4, chunkSize: 65536 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    const harness = makeSwitchHarness();
    let failApply = false;
    harness.ports.apply = () => { if (failApply) throw Error('应用失败'); };
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports, { confirm: false });
    await untilWire(wire, 'storage.v1.session.activate');
    failApply = true;
    holdB = false;
    releaseB(OK({ mode: 'managed', sessionId: 'sess-b' }));
    for (let i = 0; i < 20 && wire.filter(call => call.action === 'storage.v1.session.activate' && (call.data as { sessionId: string }).sessionId === 'sess-a').length < 1; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    await controller.leave();
    assert.equal(controller.sessionId, null, 'leave cleared the active binding before the compensation receipt');
    assert.equal(controller.identity, 'unmanaged');
    holdCompensation = false;
    releaseCompensation(OK({ mode: 'managed', sessionId: 'sess-a' }));
    const result = await switching;
    assert.equal(result.status, 'unconfirmed');
    assert.equal(controller.sessionId, null, 'the closed binding is not revived');
    assert.equal(controller.identity, 'unmanaged', 'leave identity stays');
    assert.equal(controller.unconfirmed, true);
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal(refused.status, 'failed');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'));
});

test('RP7 R01: a late leave compensation does not overwrite a binding that appeared or disappeared', async () => {
    const controller = new ManagedProjectController((async (action, data) => {
        if (action === 'storage.v1.session.leave') {
            controller.restoreBinding({ sessionId: 'sess-new', projectId: 'proj-new', projectName: '新', revision: 1, current: null, leaseOwned: true });
            controller.identity = 'managed';
            return OK({ mode: 'unmanaged', sessionId: (data as { sessionId: string }).sessionId });
        }
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    await assert.rejects(() => controller.compensateTo(null, 'sess-owned'), /保存已锁定/);
    assert.equal(controller.sessionId, 'sess-new', 'the binding that appeared during leave stays');
    assert.equal(controller.identity, 'managed', 'the late leave receipt does not force unmanaged');
    assert.equal(controller.unconfirmed, true);
});

// R01-E: the compensation of a superseded switch neither clears the RP6 WriteGate nor a
// pre-existing unconfirmed state; startup-restore semantics are covered by the F02 tests.
test('RP7 R01: the RP6 WriteGate and a pre-existing unconfirmed state survive a compensated superseded switch', async () => {
    const switchManagedCandidate = await loadSwitch();
    const { WriteGate } = await import('../src/scenes/document-apply.ts') as { WriteGate: new () => { blocked: boolean; refuse(): void; block(reason: unknown): void } };
    const gate = new WriteGate();
    gate.block(Error('界面重建失败'));
    const wire: WireCall[] = [];
    let releaseActivate!: (reply: DskReply) => void;
    const activateGate = new Promise<DskReply>(resolve => { releaseActivate = resolve; });
    let parked = true;
    const controller = new ManagedProjectController((async (action, data) => {
        wire.push({ action, data: (data ?? {}) as Record<string, unknown> });
        if (action === 'project.open') return sessionReply('sess-b', 'proj-b', '乙', 5, ref('snap-b', 5, 'proj-b'));
        if (action === 'storage.v1.session.activate') {
            const payload = data as { sessionId: string };
            if (parked && payload.sessionId === 'sess-b') return activateGate;
            return OK({ mode: 'managed', sessionId: payload.sessionId });
        }
        if (action === 'storage.v1.project.close') return OK({ closed: true });
        if (action === 'storage.v1.snapshot.read') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ snapshot: ref('snap-b', 5, 'proj-b'), transferId: 'dl-sess-b', length: bytes.length, chunkSize: 65536 });
        }
        if (action === 'storage.v1.snapshot.download.chunk') {
            const bytes = new TextEncoder().encode(JSON.stringify(makeDocument('乙档')));
            return OK({ offset: 0, data: Buffer.from(bytes).toString('base64'), final: true });
        }
        if (action === 'storage.v1.upload.begin') return OK({ transferId: 'up-r01e', declaredLength: 4, chunkSize: 65536 });
        if (action === 'storage.v1.upload.chunk') return OK({ received: 4 });
        if (action === 'storage.v1.upload.commit') return OK({ snapshot: ref('snap-e', 6, 'proj-a'), revision: 6 });
        throw Error('unexpected action ' + action);
    }) as DskCaller);
    controller.restoreBinding({ sessionId: 'sess-a', projectId: 'proj-a', projectName: '甲', revision: 2, current: ref('snap-a', 2, 'proj-a'), leaseOwned: true });
    controller.identity = 'managed';
    controller.unconfirmed = true; // a pre-existing unresolved state from before this switch
    const harness = makeSwitchHarness();
    const switching = switchManagedCandidate(controller, 'proj-b', '乙', harness.ports);
    await untilWire(wire, 'storage.v1.session.activate');
    await controller.closeSessionById('sess-b');
    parked = false;
    releaseActivate(OK({ mode: 'managed', sessionId: 'sess-b', projectId: 'proj-b' }));
    const result = await switching;
    assert.equal(result.status, 'failed', 'the compensation itself succeeded');
    assert.equal(controller.unconfirmed, true, 'the pre-existing unconfirmed state is never lifted by the compensation');
    assert.equal(gate.blocked, true, 'the RP6 WriteGate survives the compensation');
    assert.throws(() => gate.refuse(), /整档回滚失败禁写状态/, 'the blocked editor still refuses writes');
    assert.equal(controller.sessionId, 'sess-a', 'the persisted choice was compensated back to A');
    const refused = await controller.saveSnapshot(makeDocument('仍拒绝'));
    assert.equal((refused as { reason: string }).reason, 'unconfirmed', 'saves stay refused');
    assert.ok(!wire.some(call => call.action === 'storage.v1.upload.begin'), 'no upload.begin anywhere');
});
