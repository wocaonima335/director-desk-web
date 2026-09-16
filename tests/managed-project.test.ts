// DSK-004 renderer-side harness: ManagedProjectController wire flows against a scripted dsk,
// the RecoveryAutosave managed gate (no legacy recovery writes while managed) and the
// save-dirty rules in project-save (epoch/revision capture, uncertain commits, export copies).
// No real DOM: only a minimal document/window shim for the status helpers in project-save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedProjectController, StorageRequestError, type DskReply, type DskCaller } from '../src/editor/managed-project.ts';
import { RecoveryAutosave } from '../src/editor/recovery-autosave.ts';
import { canonicalJson } from '../shared/storage/canonical.ts';
import { readSceneDocument, type SceneDocument } from '../src/scenes/sequence-project.ts';
import { demoProject } from '../src/model.ts';
import { saveProjectFile, exportProjectCopy } from '../src/ui/project-save.ts';

// The canonical serializer must produce identical text when compiled to CJS for the main process
// (tests/dsk-storage.test.cjs asserts the same fixture vector on the bundled side).
assert.equal(canonicalJson({ b: 1, a: [{ z: 1, y: [2, 1] }], c: null, d: '文本' }), '{"a":[{"y":[2,1],"z":1}],"b":1,"c":null,"d":"文本"}');

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
    const bytes = new TextEncoder().encode(JSON.stringify(document));
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
        throw Error('unexpected action ' + action);
    };
    const controller = new ManagedProjectController(dsk);
    await controller.create('保存');
    const outcome = await controller.saveSnapshot(document);
    assert.equal(outcome.status, 'saved');
    assert.equal(controller.revision, 1);
    assert.equal(controller.current?.snapshotId, 'snap-0001');
    const actions = log.map(entry => entry.action);
    assert.equal(actions[0], 'project.create');
    assert.equal(actions[1], 'storage.v1.upload.begin');
    assert.equal(actions[actions.length - 1], 'storage.v1.upload.commit');
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
    assert.equal(controller.revision, 1, 'uncertain outcome must not advance the local revision');
    assert.equal(controller.current, null);
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
