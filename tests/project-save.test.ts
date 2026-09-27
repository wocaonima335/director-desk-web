import test from 'node:test';
import assert from 'node:assert/strict';
import { exportProjectCopy, saveProjectFile } from '../src/ui/project-save.ts';
import { ManagedProjectController, type DskCaller } from '../src/editor/managed-project.ts';
import { readSceneDocument, type SceneDocument } from '../src/scenes/sequence-project.ts';
import { demoProject } from '../src/model.ts';
import type { AppContext } from '../src/app-context.ts';

test('save marks clean only after confirmed disk success, keeping canceled/failed work dirty and blocking concurrent edits', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let complete: (v: unknown) => void = () => {};
    const states: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { directorDesktop: { files: () => new Promise(resolve => complete = resolve) } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ textContent: '' }) } });
    const ctx = { dirty: true, busy: false, playing: true, draft: null, engine: { exporting: false }, history: { pending: null },
        scenes: { document: () => ({ name: '测试', scenes: [{ id: 'first' }, { id: 'second' }] }) }, updateTimeUI() {}, toast: (s: string) => states.push(s),
    } as unknown as AppContext;
    try {
        let saving = saveProjectFile(ctx); assert.equal(ctx.dirty, true); assert.equal(ctx.busy, true);
        assert.equal(await saveProjectFile(ctx), false);
        complete({ ok: true, data: { saved: false } }); assert.equal(await saving, false);
        assert.equal(ctx.dirty, true); assert.equal(ctx.busy, false);
        saving = saveProjectFile(ctx); complete({ ok: false, error: 'disk full' }); assert.equal(await saving, false);
        assert.equal(ctx.dirty, true); assert.equal(ctx.busy, false);
        saving = saveProjectFile(ctx); complete({ ok: true, data: { saved: true } }); assert.equal(await saving, true);
        assert.equal(ctx.dirty, false); assert.equal(ctx.busy, false); assert.ok(states.some(s => s.includes('2 个独立戏段')));
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    }
});

// --- RP7: the unconfirmed block lives in the controller, not only in the UI --------------------

function makeDocument(name: string): SceneDocument {
    const document = readSceneDocument(demoProject());
    document.name = name;
    return document;
}

test('RP7-A8: the controller refuses an unconfirmed save even when the UI check is bypassed; only a full reopen clears it', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const wire: string[] = [];
    const managed = new ManagedProjectController((async (action: string) => {
        wire.push(action);
        if (action === 'storage.v1.upload.begin') return { ok: true, data: { transferId: 'up-r', declaredLength: 4, chunkSize: 65536 } };
        if (action === 'storage.v1.upload.chunk') return { ok: true, data: { received: 4 } };
        if (action === 'storage.v1.upload.commit') return { ok: true, data: { snapshot: { version: 'dsk.v1', snapshotId: 'snap-r10', projectId: 'proj-r', revision: 10, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' }, revision: 10 } };
        throw Error('unexpected action ' + action);
    }) as unknown as DskCaller);
    managed.restoreBinding({ sessionId: 'sess-r', projectId: 'proj-r', projectName: '未确认', revision: 5, current: null, leaseOwned: true });
    managed.identity = 'managed';
    managed.unconfirmed = true; // a prior switch failed and its compensation failed too
    const statusNodes = new Map<string, { textContent: string }>();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: (selector: string) => statusNodes.get(selector) ?? null } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { directorDesktop: undefined } });
    let revisionValue = 5;
    const ctx = {
        busy: false, playing: false, dirty: true, draft: null,
        get revision() { return revisionValue; },
        engine: { exporting: false },
        history: { pending: null },
        managed,
        scenes: { document: () => makeDocument('未确认') },
        toast: () => {},
        updateTimeUI() {},
    } as unknown as AppContext & { dirty: boolean };
    try {
        // The UI check still fires first and keeps dirty.
        assert.equal(await saveProjectFile(ctx), false);
        assert.equal(ctx.dirty, true);
        assert.equal(wire.length, 0, 'the UI check must not produce wire traffic');
        // Bypassing the UI (direct controller call) must refuse at the controller entry too.
        const direct = await managed.saveSnapshot(makeDocument('未确认'));
        assert.equal(direct.status, 'failed');
        assert.equal((direct as { reason?: string }).reason, 'unconfirmed');
        assert.equal(wire.length, 0, 'the controller refusal must not reach the wire (no upload.begin)');
        assert.equal(managed.revision, 5, 'the refused save must not change revision');
        assert.equal(managed.current, null);
        // Only a fully successful reopen clears the unconfirmed state: adopting the downloaded
        // snapshot after the document was applied ends the unresolved state.
        const snapshot = { version: 'dsk.v1', snapshotId: 'snap-r9', projectId: 'proj-r', revision: 9, digest: 'b'.repeat(64), createdAt: '2026-09-16T00:00:00Z' };
        const adopt = (managed as unknown as { adoptDownloadedSnapshot?: (value: unknown) => void }).adoptDownloadedSnapshot;
        assert.equal(typeof adopt, 'function', 'RP7: adoptDownloadedSnapshot missing');
        adopt!.call(managed, snapshot);
        assert.equal(managed.unconfirmed, false, 'the successful reopen cleared the unconfirmed state');
        assert.equal(managed.revision, 9);
        wire.length = 0;
        assert.equal(await saveProjectFile(ctx), true, 'the save works again after the resolved reopen');
        assert.equal(ctx.dirty, false);
        assert.ok(wire.includes('storage.v1.upload.begin'), 'the save reached the wire again');
        assert.equal(managed.revision, 10);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    }
});

// --- RP7 REPLAN R02: the RP6 write gate blocks every save/leave entry before any split or wire
// traffic, and a gate raised mid-save keeps the dirty flag even when a receipt lands. ----------

const DENIAL = '编辑器处于整档回滚失败禁写状态，请重启应用：演示';

async function flushR02() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

/** Minimal DOM for mountProjectLibrary: $() is document.querySelector, and the open button is
 * appended to body before the modal handler is registered. */
function installLibraryDom(statusNodes: Map<string, { textContent: string }>) {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const library = {
        addEventListener(type: string, handler: (event: unknown) => void) {
            const list = listeners.get(type) ?? [];
            list.push(handler);
            listeners.set(type, list);
        },
        querySelector: (selector: string) => selector === '#library-new-name' ? { value: '' } : null,
        dispatch(event: unknown) {
            for (const handler of listeners.get('click') ?? []) handler(event);
        },
    };
    let openClick: (() => void) | undefined;
    const button = {
        type: '', id: '', className: '',
        setAttribute() { },
        set textContent(_value: string) { },
        addEventListener(_type: string, handler: () => void) { openClick = handler; },
    };
    const body = { append() { } };
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: () => button,
            body,
            querySelector: (selector: string) => selector === '#project-library' ? library : (statusNodes.get(selector) ?? null),
        },
    });
    return {
        openLibrary: () => openClick?.(),
        fireLeave: () => library.dispatch({
            target: { closest: (selector: string) => selector === '[data-library-act]' ? { dataset: { libraryAct: 'leave' } } : null },
        }),
    };
}
async function waitForR02(predicate: () => boolean, what: string) {
    for (let i = 0; i < 500 && !predicate(); i++) await Promise.resolve();
    assert.ok(predicate(), `R02 harness: never observed ${what}`);
}

interface R02Counters { docReads: number; finishPaths: number; filesCalls: number; saves: number; }

/** Installs the document/window shims and returns a plain unmanaged ctx plus call counters. */
function makeR02PlainCtx(extra: { managed?: ManagedProjectController; withDraft?: boolean } = {}) {
    const counters: R02Counters = { docReads: 0, finishPaths: 0, filesCalls: 0, saves: 0 };
    const statusNodes = new Map<string, { textContent: string }>();
    statusNodes.set('#save-status', { textContent: 'KEEP' });
    const filesPayloads: Array<Record<string, unknown>> = [];
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { querySelector: (selector: string) => statusNodes.get(selector) ?? null },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            directorDesktop: {
                files: (_kind: string, payload: Record<string, unknown>) => {
                    counters.filesCalls += 1;
                    filesPayloads.push(payload);
                    return Promise.resolve({ ok: true, data: { saved: true } });
                },
            },
        },
    });
    const ctx = {
        dirty: true, busy: false, playing: false,
        draft: extra.withDraft ? { id: 'path' } : null,
        writeBlockedReason: null as string | null,
        engine: { exporting: false },
        history: { pending: null },
        managed: extra.managed,
        scenes: { document: () => { counters.docReads += 1; return { name: '测试', scenes: [{ id: 'first' }, { id: 'second' }] }; } },
        finishPath: () => { counters.finishPaths += 1; },
        toast: () => { },
        updateTimeUI() { },
    } as unknown as AppContext & { dirty: boolean; writeBlockedReason: string | null };
    return { ctx, counters, statusNodes, filesPayloads };
}

function restoreR02Shims(previousWindow: PropertyDescriptor | undefined, previousDocument: PropertyDescriptor | undefined) {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
}

function makeR02Managed(): { managed: ManagedProjectController; wire: string[] } {
    const wire: string[] = [];
    const managed = new ManagedProjectController((async (action: string) => {
        wire.push(action);
        if (action === 'storage.v1.upload.begin') return { ok: true, data: { transferId: 'up-r02', declaredLength: 4, chunkSize: 65536 } };
        if (action === 'storage.v1.upload.chunk') return { ok: true, data: { received: 4 } };
        if (action === 'storage.v1.upload.commit') return { ok: true, data: { snapshot: { version: 'dsk.v1', snapshotId: 'snap-r02', projectId: 'proj-r02', revision: 6, digest: 'a'.repeat(64), createdAt: '2026-09-16T00:00:00Z' }, revision: 6 } };
        if (action === 'storage.v1.session.leave') return { ok: true, data: { mode: 'unmanaged' } };
        throw Error('unexpected action ' + action);
    }) as unknown as DskCaller);
    managed.restoreBinding({ sessionId: 'sess-r02', projectId: 'proj-r02', projectName: '门控', revision: 5, current: null, leaseOwned: true });
    managed.identity = 'managed';
    return { managed, wire };
}

// R02-A (plain half): the gate is checked BEFORE the managed/unmanaged split — a blocked editor
// never reads the document, never finishes a live path and never reaches files('save-project').
test('RP7 R02: a write-blocked editor refuses the plain save before the split — no read, no finishPath, no files call, dirty kept', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        // With a live path draft: even finishPath must not run for a blocked editor.
        const drafted = makeR02PlainCtx({ withDraft: true });
        drafted.ctx.writeBlockedReason = DENIAL;
        assert.equal(await saveProjectFile(drafted.ctx), false);
        assert.equal(drafted.counters.finishPaths, 0, 'a blocked save must not finish the live path');
        assert.equal(drafted.counters.docReads, 0, 'a blocked save must not read the document');
        assert.equal(drafted.counters.filesCalls, 0, 'a blocked save must not reach files(save-project)');
        assert.equal(drafted.ctx.dirty, true, 'a refused save keeps dirty');
        // Without a draft: the refusal still happens before any read or file write.
        const plain = makeR02PlainCtx();
        plain.ctx.writeBlockedReason = DENIAL;
        assert.equal(await saveProjectFile(plain.ctx), false);
        assert.equal(plain.counters.docReads, 0);
        assert.equal(plain.counters.filesCalls, 0);
        assert.equal(plain.ctx.dirty, true);
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-A (managed half): the blocked snapshot save is refused before the split too — no path
// finish, no document read, no upload.
test('RP7 R02: a write-blocked editor refuses the managed snapshot save before the split without finishing a live path or uploading', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const { managed, wire } = makeR02Managed();
        const harness = makeR02PlainCtx({ managed, withDraft: true });
        harness.ctx.writeBlockedReason = DENIAL;
        assert.equal(await saveProjectFile(harness.ctx), false);
        assert.equal(harness.counters.finishPaths, 0, 'a blocked managed save must not finish the live path');
        assert.equal(harness.counters.docReads, 0, 'a blocked managed save must not read the document');
        assert.ok(!wire.includes('storage.v1.upload.begin'), 'a blocked managed save never begins an upload');
        assert.equal(harness.ctx.dirty, true);
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-B: the project-library leave entry checks the gate before the drain AND after the drain
// before sending leave; a blocked leave never touches identity or the status line.
test('RP7 R02: the library leave entry checks the write gate before the drain and again before sending leave, keeping the identity and status line', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const { mountProjectLibrary } = await import('../src/ui/project-library.ts') as { mountProjectLibrary: (ctx: AppContext) => unknown };
        const { managed, wire } = makeR02Managed();
        const statusNodes = new Map<string, { textContent: string }>();
        statusNodes.set('#save-status', { textContent: 'KEEP' });
        let modalCalls = 0, closeCalls = 0, toasts = 0;
        const toastsLog: string[] = [];
        const libraryDom = installLibraryDom(statusNodes);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { directorDesktop: { dsk: (_action: string, _data?: unknown) => Promise.resolve({ ok: true, data: { projects: [], nextCursor: null } }) } },
        });
        const drainCalls: number[] = [];
        let releaseDrain: (() => void) | undefined;
        const ctx = {
            busy: false, playing: false, dirty: true, draft: null,
            writeBlockedReason: null as string | null,
            project: { name: '测试工程' },
            engine: { exporting: false },
            history: { pending: null },
            managed,
            drainRecovery: () => { drainCalls.push(1); return new Promise<void>(resolve => { releaseDrain = resolve; }); },
            toast: (message: string) => { toasts += 1; toastsLog.push(message); },
            showModal: () => { modalCalls += 1; },
            closeModal: () => { closeCalls += 1; },
            updateTimeUI() { },
        } as unknown as AppContext;
        const gate = ctx as unknown as { writeBlockedReason: string | null };
        mountProjectLibrary(ctx);
        const dispatchLeave = () => libraryDom.openLibrary();
        const fireLeave = () => libraryDom.fireLeave();
        const leaves = () => wire.filter(action => action === 'storage.v1.session.leave').length;

        // Open the library once so the leave action handler is registered.
        dispatchLeave();
        await waitForR02(() => modalCalls === 1, 'the library modal');
        // Phase 1: blocked before the drain — no drain, no leave, no identity/status change.
        gate.writeBlockedReason = DENIAL;
        fireLeave();
        await flushR02();
        assert.equal(drainCalls.length, 0, 'a blocked leave never drains');
        assert.equal(leaves(), 0, 'a blocked leave never sends session.leave');
        assert.equal(managed.identity, 'managed', 'the managed identity is untouched');
        assert.equal(statusNodes.get('#save-status')!.textContent, 'KEEP', 'the status line is untouched');
        assert.equal(closeCalls, 0, 'a blocked leave never closes the modal');
        // Phase 2: the gate is raised while the drain is in flight — re-checked before leave.
        gate.writeBlockedReason = null;
        fireLeave();
        await waitForR02(() => drainCalls.length === 1, 'the first drain');
        gate.writeBlockedReason = DENIAL;
        releaseDrain!();
        await flushR02();
        assert.equal(leaves(), 0, 'a gate raised during the drain still blocks the leave');
        assert.equal(managed.identity, 'managed');
        assert.equal(statusNodes.get('#save-status')!.textContent, 'KEEP');
        assert.equal(closeCalls, 0);
        // Control: unblocked, the leave goes out once and the identity honestly flips.
        gate.writeBlockedReason = null;
        fireLeave();
        await waitForR02(() => drainCalls.length === 2, 'the control drain');
        releaseDrain!();
        await waitForR02(() => closeCalls === 1, 'the successful leave');
        assert.equal(leaves(), 1, 'exactly one session.leave for the successful leave');
        assert.equal(managed.identity, 'unmanaged', 'the server-side unmanaged state is acknowledged');
        assert.equal(statusNodes.get('#save-status')!.textContent, '普通会话（未管理）');
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-C: a leave that already went out and succeeded is acknowledged (server is unmanaged), but
// a write gate raised afterwards still refuses the now-plain save.
test('RP7 R02: after a successful leave the server is honestly unmanaged but a raised write gate still refuses the plain save', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const { mountProjectLibrary } = await import('../src/ui/project-library.ts') as { mountProjectLibrary: (ctx: AppContext) => unknown };
        const { managed, wire } = makeR02Managed();
        const statusNodes = new Map<string, { textContent: string }>();
        statusNodes.set('#save-status', { textContent: 'KEEP' });
        let modalCalls = 0, closeCalls = 0;
        const libraryDom = installLibraryDom(statusNodes);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { directorDesktop: { dsk: () => Promise.resolve({ ok: true, data: { projects: [], nextCursor: null } }) } },
        });
        const ctx = {
            busy: false, playing: false, dirty: true, draft: null,
            writeBlockedReason: null as string | null,
            project: { name: '测试工程' },
            engine: { exporting: false },
            history: { pending: null },
            managed,
            drainRecovery: async () => { },
            toast: () => { },
            showModal: () => { modalCalls += 1; },
            closeModal: () => { closeCalls += 1; },
            updateTimeUI() { },
        } as unknown as AppContext;
        mountProjectLibrary(ctx);
        libraryDom.openLibrary();
        await waitForR02(() => modalCalls === 1, 'the library modal');
        libraryDom.fireLeave();
        await waitForR02(() => closeCalls === 1, 'the successful leave');
        assert.equal(wire.filter(action => action === 'storage.v1.session.leave').length, 1, 'the leave really went out');
        assert.equal(managed.identity, 'unmanaged', 'the unmanaged identity is acknowledged, not hidden');
        // Now the editor becomes write-blocked: the plain save must refuse before any file write.
        const harness = makeR02PlainCtx();
        harness.ctx.writeBlockedReason = DENIAL;
        harness.ctx.dirty = true;
        assert.equal(await saveProjectFile(harness.ctx), false);
        assert.equal(harness.counters.filesCalls, 0, 'the write-blocked plain save never reaches files(save-project)');
        assert.equal(harness.counters.docReads, 0);
        assert.equal(harness.ctx.dirty, true, 'a refused save keeps dirty');
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-D (plain half): the gate raised while the file write is in flight cannot undo the file,
// but the success receipt must not report a clean save.
test('RP7 R02: a write gate raised while the plain save is in flight keeps dirty when the receipt lands', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const statusNodes = new Map<string, { textContent: string }>();
        statusNodes.set('#save-status', { textContent: 'KEEP' });
        let releaseFiles!: (reply: unknown) => void;
        let filesCalls = 0;
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { querySelector: (selector: string) => statusNodes.get(selector) ?? null },
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                directorDesktop: {
                    files: () => new Promise(resolve => {
                        filesCalls += 1;
                        releaseFiles = resolve;
                    }),
                },
            },
        });
        const ctx = {
            dirty: true, busy: false, playing: false, draft: null,
            writeBlockedReason: null as string | null,
            engine: { exporting: false },
            history: { pending: null },
            scenes: { document: () => ({ name: '测试', scenes: [{ id: 'first' }] }) },
            finishPath() { },
            toast: () => { },
            updateTimeUI() { },
        } as unknown as AppContext & { dirty: boolean; writeBlockedReason: string | null };
        const saving = saveProjectFile(ctx); // unblocked at entry — the write may proceed
        await flushR02();
        assert.equal(filesCalls, 1, 'an unblocked save reaches the file write');
        ctx.writeBlockedReason = DENIAL; // the editor becomes write-blocked while the write is pending
        releaseFiles!({ ok: true, data: { saved: true } });
        assert.equal(await saving, false, 'the success receipt must not report a clean save');
        assert.equal(ctx.dirty, true, 'the success receipt must not clear dirty once write-blocked');
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-D (managed half): same rule for the snapshot save — a committed snapshot cannot be
// uncommitted, but the receipt must not clear the dirty flag of a write-blocked editor.
test('RP7 R02: a write gate raised while the snapshot upload is in flight keeps dirty on the saved receipt', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const statusNodes = new Map<string, { textContent: string }>();
        statusNodes.set('#save-status', { textContent: 'KEEP' });
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { querySelector: (selector: string) => statusNodes.get(selector) ?? null },
        });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { directorDesktop: undefined } });
        const { managed } = makeR02Managed();
        let revisionValue = 5;
        const ctx = {
            busy: false, playing: false, dirty: true, draft: null,
            writeBlockedReason: null as string | null,
            get revision() { return revisionValue; },
            engine: { exporting: false },
            history: { pending: null },
            managed,
            scenes: { document: () => makeDocument('门控中保存') },
            toast: () => { },
            updateTimeUI() { },
        } as unknown as AppContext & { dirty: boolean; writeBlockedReason: string | null };
        (managed as unknown as { saveSnapshot: () => Promise<unknown> }).saveSnapshot = async () => {
            ctx.writeBlockedReason = DENIAL; // the gate is raised while the upload is pending
            return { status: 'saved', snapshot: { version: 'dsk.v1' }, revision: 6 };
        };
        assert.equal(await saveProjectFile(ctx), false, 'a saved receipt under the gate must not report a clean save');
        assert.equal(ctx.dirty, true, 'the saved receipt must not clear dirty once write-blocked');
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});

// R02-E: the explicit export copy keeps its existing behavior (also while write-blocked), and
// the plain save is never converted into an export copy.
test('RP7 R02: the explicit export copy keeps its behavior while write-blocked and the plain save stays a plain save', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        const harness = makeR02PlainCtx();
        harness.ctx.writeBlockedReason = DENIAL;
        assert.equal(await exportProjectCopy(harness.ctx as unknown as AppContext), true, 'the explicit export copy keeps exporting');
        assert.equal(harness.counters.filesCalls, 1, 'the export copy still reaches files(save-project)');
        assert.equal(harness.ctx.dirty, true, 'a copy is not a save — dirty survives');
        // The plain save (unblocked) is not turned into an export copy: success clears dirty.
        harness.ctx.writeBlockedReason = null;
        assert.equal(await saveProjectFile(harness.ctx), true);
        assert.equal(harness.counters.filesCalls, 2);
        assert.equal(harness.ctx.dirty, false, 'an unblocked plain save clears dirty exactly like before');
    } finally {
        restoreR02Shims(previousWindow, previousDocument);
    }
});
