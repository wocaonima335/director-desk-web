import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { demoProject, entity, type Project } from '../src/model.ts';
import { SceneWorkspace } from '../src/scenes/scene-workspace.ts';
import { SceneModels } from '../src/resources/scene-models.ts';
import { applyWholeDocument, WriteGate, type RollbackStage, type WholeDocumentPorts } from '../src/scenes/document-apply.ts';
import { duplicateDocumentScene, projectForScene, readSceneDocument, type SceneDocument } from '../src/scenes/sequence-project.ts';
import { packModelFiles } from '../src/resources/model-package.ts';
import { modelResourceId } from '../src/resources/project-resources.ts';

const chairBytes = new Uint8Array(await fs.readFile('test-assets/external/kenney-furniture/Models/GLTF format/chair.glb'));
const bearBytes = new Uint8Array(await fs.readFile('test-assets/external/kenney-furniture/Models/GLTF format/bear.glb'));

async function documentWithModel(name: string, bytes: Uint8Array): Promise<SceneDocument> {
    const data = packModelFiles(name, [{ path: name, bytes }]), id = await modelResourceId(data);
    const project = demoProject();
    project.version = 2;
    project.resources = [{ id, name, package: data, source: 'Kenney', copyright: '', license: 'CC0' }];
    const prop = entity('prop', 'external-model', name);
    prop.external = { resourceId: id, appearance: 'white', unitScale: 1, orientation: [0, 0, 0] };
    project.entities.push(prop);
    return duplicateDocumentScene(readSceneDocument(project), 'scene-main', '第二场', 'scene-b');
}

interface FakeSnapshot {
    history: ReturnType<SceneWorkspace['captureDocumentState']>;
    models: ReturnType<SceneModels['captureModelState']>;
    view: { time: number; preview: string; selected: string };
    playing: boolean;
    epoch: number;
}

/** Editor-shaped ports over a real SceneWorkspace: live view, playback flag, epoch counter and
 * the same capture/commit/present/rollback wiring main.ts uses, with failure injection hooks.
 * present() mirrors main.ts changed(): it retains only what the new document and its history
 * still own — the exact step that used to dispose pre-apply model resources (RP6-R01). */
function buildEditor(workspace: SceneWorkspace, models: SceneModels, initial: Project) {
    const view = { value: { time: 3, preview: 'program', selected: initial.entities[0].id } };
    const playback = { playing: false };
    const gate = new WriteGate();
    const calls = { capture: 0, commit: 0, present: 0, applied: 0, rollback: 0, writeBlocked: 0, republished: 0, stages: [] as RollbackStage[] };
    let blockedApply: unknown = null;
    let blockedRollback: unknown = null;
    const hooks = {
        prepare: undefined as ((document: SceneDocument) => void) | undefined,
        present: undefined as (() => void) | undefined,
        rollback: undefined as (() => void) | undefined,
    };
    const ports: WholeDocumentPorts = {
        guard: () => gate.refuse(),
        prepare: document => {
            if (hooks.prepare) { hooks.prepare(document); return; }
            for (const scene of document.scenes) models.assertReady(projectForScene(document, scene.id));
        },
        capture: (): FakeSnapshot => {
            calls.capture++;
            return { history: workspace.captureDocumentState(), models: models.acquireModelState(), view: { ...view.value }, playing: playback.playing, epoch: 7 };
        },
        commit: (document, options) => {
            calls.commit++;
            return options.resetHistory ? workspace.reset(document) : workspace.replace(document, options.context, options.label, options.resetViews);
        },
        present: () => {
            calls.present++;
            // The same retain main.ts runs inside changed() while presenting the new document.
            models.retain([workspace.project(), ...workspace.undoStack, ...workspace.redoStack]);
            if (hooks.present) { hooks.present(); return; }
            view.value = { ...workspace.restoredView! };
        },
        applied: snapshot => {
            calls.applied++;
            const saved = snapshot as FakeSnapshot;
            models.releaseModelState(saved.models);
            models.retain([workspace.project(), ...workspace.undoStack, ...workspace.redoStack]);
        },
        rollback: (snapshot, stage) => {
            calls.rollback++;
            calls.stages.push(stage);
            const saved = snapshot as FakeSnapshot;
            workspace.restoreDocumentState(saved.history);
            models.restoreModelState(saved.models);
            models.releaseModelState(saved.models);
            if (stage === 'swap') {
                // The document had been replaced: restore the captured view and re-present (changed()).
                view.value = { ...saved.view };
                playback.playing = saved.playing; // RP6-R03: restore the captured flag exactly, never a forced stop.
                calls.republished++;
                models.retain([workspace.project(), ...workspace.undoStack, ...workspace.redoStack]);
            }
            // stage 'prepare': the candidate never replaced the document — the live view, playback
            // and selections stay untouched and no re-presentation/save happens.
            if (hooks.rollback) hooks.rollback(); // failed re-presentation → rollback itself fails
            return workspace.project();
        },
        writeBlocked: (applyError, rollbackError) => {
            calls.writeBlocked++;
            blockedApply = applyError;
            blockedRollback = rollbackError;
            gate.block(rollbackError);
        },
    };
    return { ports, calls, view, playback, hooks, blocked: () => ({ apply: blockedApply, rollback: blockedRollback }) };
}

/** One committed edit on top of the fresh workspace, so the pre-apply history is non-trivial. */
function commitOneEdit(workspace: SceneWorkspace, name: string) {
    const working = workspace.project(); working.name = name;
    workspace.begin(working); workspace.commit(working);
}

test('RP6: prepare-stage failure changes nothing — document, history, views, resources and epoch stay exact', async () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    commitOneEdit(workspace, '工程A');
    assert.equal(workspace.undoStack.length, 1);
    const before = workspace.document();
    const beforeRevision = workspace.context.revision;
    const beforeSessionId = workspace.context.sessionId;
    const candidate = await documentWithModel('chair.glb', chairBytes); // resource was never loaded
    const models = new SceneModels();
    const editor = buildEditor(workspace, models, initial);
    editor.playback.playing = true; // RP6-R03: playback must survive a prepare-stage failure
    const outcome = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(outcome.status, 'rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    assert.match(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), /模型资源加载/);
    assert.equal(editor.calls.commit, 0, 'prepare must fail before the document swap');
    assert.equal(editor.calls.present, 0);
    assert.equal(editor.calls.applied, 0);
    assert.equal(editor.calls.writeBlocked, 0);
    assert.equal(editor.calls.rollback, 1, 'even a prepare failure rolls back its validation leftovers');
    assert.deepEqual(editor.calls.stages, ['prepare'], 'a prepare-stage failure reports the prepare stage');
    assert.equal(editor.playback.playing, true, 'playback is preserved when the document was never replaced');
    assert.equal(editor.calls.republished, 0, 'no needless re-presentation/save for a prepare-stage failure');
    assert.deepEqual(workspace.document(), before, 'document unchanged');
    assert.equal(workspace.undoStack.length, 1, 'history unchanged');
    assert.equal(workspace.redoStack.length, 0);
    assert.equal(workspace.context.revision, beforeRevision, 'revision unchanged');
    assert.equal(workspace.context.sessionId, beforeSessionId, 'session binding unchanged');
    assert.equal(models.captureModelState().sources.size, 0, 'no model resource was staged');
    assert.deepEqual(editor.view.value, initialView(initial), 'live view unchanged');
    // The editor stays usable after the refused apply.
    const next = readSceneDocument(demoProject()); next.name = '恢复后可用';
    const applied = workspace.replace(next, workspace.context, '打开', true);
    assert.equal(applied.name, '恢复后可用');
});

test('RP6: a failure after the swap rolls document, history, view and resources back (replace)', async () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    commitOneEdit(workspace, '工程A');
    const firstName = initial.name;
    const before = workspace.document();
    const beforeRevision = workspace.context.revision;
    const candidate = readSceneDocument(demoProject()); candidate.name = '工程B';
    const editor = buildEditor(workspace, new SceneModels(), initial);
    editor.playback.playing = true; // the captured playback flag must survive a post-swap failure exactly
    editor.hooks.present = () => {
        editor.view.value = { time: 999, preview: 'program', selected: candidate.scenes[0].state.entities[0].id };
        throw Error('演示失败');
    };
    const outcome = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true });
    assert.equal(outcome.status, 'rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    assert.equal((outcome.error as Error).message, '演示失败');
    assert.equal(editor.calls.commit, 1);
    assert.equal(editor.calls.present, 1);
    assert.equal(editor.calls.applied, 0, 'success-only side effects never run after a failure');
    assert.equal(editor.calls.rollback, 1);
    assert.equal(editor.calls.writeBlocked, 0);
    assert.deepEqual(editor.calls.stages, ['swap'], 'a post-swap failure reports the swap stage');
    assert.equal(editor.playback.playing, true, 'a post-swap failure restores the captured playing state exactly (RP6-R03)');
    assert.equal(editor.calls.republished, 1, 'a post-swap failure re-presents the original document');
    assert.deepEqual(workspace.document(), before, 'original document restored');
    assert.equal(workspace.undoStack.length, 1, 'the apply-time undo entry is gone');
    assert.equal(workspace.context.revision, beforeRevision, 'revision restored exactly');
    assert.deepEqual(editor.view.value, initialView(initial), 'live view restored');
    // History still works: undo reaches across the failed apply to the true previous document.
    const undone = workspace.undo(workspace.project());
    assert.equal(undone!.name, firstName);
});

test('RP6: resetHistory swaps a fresh session and rollback reinstates the original one', async () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    commitOneEdit(workspace, '工程A');
    const firstName = initial.name;
    const before = workspace.document();
    const beforeSessionId = workspace.context.sessionId;
    const candidate = readSceneDocument(demoProject()); candidate.name = '工程B';
    const editor = buildEditor(workspace, new SceneModels(), initial);
    editor.hooks.present = () => { throw Error('演示失败'); };
    const outcome = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(outcome.status, 'rolled-back');
    assert.deepEqual(workspace.document(), before, 'original document restored across the session swap');
    assert.equal(workspace.undoStack.length, 1, 'the fresh session is discarded with its empty history');
    assert.equal(workspace.context.sessionId, beforeSessionId, 'the original session identity is reinstated');
    const undone = workspace.undo(workspace.project());
    assert.equal(undone!.name, firstName, 'undo history of the reinstated session still works');
});

test('RP6: a failed rollback enters the explicit write-blocked state and refuses further applies', async () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    commitOneEdit(workspace, '工程A');
    const candidate = readSceneDocument(demoProject()); candidate.name = '工程B';
    const editor = buildEditor(workspace, new SceneModels(), initial);
    editor.hooks.present = () => { throw Error('演示失败'); };
    editor.hooks.rollback = () => { throw Error('界面重建失败'); };
    const outcome = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true });
    assert.equal(outcome.status, 'write-blocked');
    if (outcome.status !== 'write-blocked') throw new Error('unreachable');
    assert.equal((outcome.error as Error).message, '演示失败');
    assert.equal((outcome.rollbackError as Error).message, '界面重建失败');
    assert.equal(editor.calls.applied, 0);
    assert.equal(editor.calls.writeBlocked, 1, 'the blocked state is signalled exactly once');
    const blocked = editor.blocked();
    assert.equal((blocked.apply as Error).message, '演示失败');
    assert.equal((blocked.rollback as Error).message, '界面重建失败');
    // The write-blocked guard refuses any further whole-document apply without touching state.
    const captures = editor.calls.capture;
    const refused = applyWholeDocument(editor.ports, candidate, workspace.context, '再试一次', { resetViews: true });
    assert.equal(refused.status, 'refused');
    assert.equal(editor.calls.capture, captures, 'a refused apply never captures or changes anything');
});

test('RP6: a refused guard changes nothing and a clean apply keeps the existing behaviour', async () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    const candidate = readSceneDocument(demoProject()); candidate.name = '工程B';
    const editor = buildEditor(workspace, new SceneModels(), initial);
    const guard = { blocked: true };
    editor.ports.guard = () => { if (guard.blocked) throw Error('请先完成当前编辑或导出'); };
    const refused = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true });
    assert.equal(refused.status, 'refused');
    assert.equal(editor.calls.capture, 0, 'refusal happens before the capture');
    assert.equal(editor.calls.commit, 0);
    assert.equal(editor.calls.present, 0);
    assert.equal(editor.calls.applied, 0);
    assert.equal(editor.calls.rollback, 0);
    assert.equal(workspace.document().name, initial.name);
    // Success path: same observable behaviour as before RP6 (document swapped, undo pushed, applied run).
    guard.blocked = false;
    const outcome = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true });
    assert.equal(outcome.status, 'applied');
    if (outcome.status !== 'applied') throw new Error('unreachable');
    assert.equal(outcome.project.name, '工程B');
    assert.deepEqual(workspace.document().name, '工程B');
    assert.equal(workspace.undoStack.length, 1, 'plain imports keep the previous document in undo');
    assert.equal(editor.calls.applied, 1);
    assert.deepEqual(editor.view.value, { time: 0, preview: 'program', selected: outcome.project.entities[0].id });
});

test('RP6: SceneModels captures and restores its loaded-source catalog exactly', async () => {
    const models = new SceneModels();
    const chair = await documentWithModel('chair.glb', chairBytes);
    const bear = await documentWithModel('bear.glb', bearBytes);
    await models.prepare(projectForScene(chair)); // additive load of the current document's resource
    const saved = models.captureModelState();
    assert.equal(saved.sources.size, 1);
    await models.prepare(projectForScene(bear)); // additive load for the candidate only
    assert.equal(models.captureModelState().sources.size, 2);
    models.assertReady(projectForScene(bear));
    models.restoreModelState(saved); // rollback disposes the candidate-only leftover
    assert.equal(models.captureModelState().sources.size, 1);
    models.assertReady(projectForScene(chair));
    assert.throws(() => models.assertReady(projectForScene(bear)), /模型资源加载/);
    // Restore also re-adds entries that disappeared after the capture.
    models.retain([{}]); // dispose every source
    assert.equal(models.captureModelState().sources.size, 0);
    models.restoreModelState(saved);
    models.assertReady(projectForScene(chair));
    assert.equal(models.captureModelState().sources.size, 1);
    assert.deepEqual([...models.captureModelState().retargets], [...saved.retargets]);
});

test('RP6: rollback leaves the current document model resources actually instantiable', async () => {
    const chairDoc = await documentWithModel('chair.glb', chairBytes);
    const bearDoc = await documentWithModel('bear.glb', bearBytes);
    const chairProject = projectForScene(chairDoc);
    const workspace = new SceneWorkspace(chairProject, () => ({ time: 3, preview: 'program', selected: chairProject.entities[0].id }));
    const models = new SceneModels();
    await models.prepare(chairProject); // the current document's resource is really loaded
    await models.prepare(projectForScene(bearDoc)); // the candidate is preloaded before the apply
    commitOneEdit(workspace, '工程A');
    const editor = buildEditor(workspace, models, chairProject);
    editor.hooks.present = () => { throw Error('演示失败'); };
    // resetHistory drops the old session, so the apply's own retain would dispose the chair
    // source; a rollback that only restored the reference would fail on first use (RP6-R01).
    const outcome = applyWholeDocument(editor.ports, bearDoc, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(outcome.status, 'rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    assert.deepEqual(editor.calls.stages, ['swap']);
    assert.equal(models.captureModelState().sources.size, 1, 'the candidate-only preload is retired by the rollback');
    assert.throws(() => models.assertReady(projectForScene(bearDoc)), /模型资源加载/);
    // The restored catalog is not just present: instances can really be created and sampled.
    const restored = projectForScene(chairDoc);
    models.assertReady(restored);
    const prop = restored.entities.find(e => e.external)!;
    const root = models.create(prop);
    assert.ok(root.children.length > 0, 'the restored model really instantiates');
    models.sample(prop, false, 0);
    models.removeInstance(prop.id);
});

test('RP6: rollback leaves history-only model resources actually instantiable', async () => {
    const chairDoc = await documentWithModel('chair.glb', chairBytes);
    const bearDoc = await documentWithModel('bear.glb', bearBytes);
    const chairProject = projectForScene(chairDoc);
    const workspace = new SceneWorkspace(chairProject, () => ({ time: 3, preview: 'program', selected: chairProject.entities[0].id }));
    const models = new SceneModels();
    await models.prepare(chairProject);
    await models.prepare(projectForScene(bearDoc));
    // A committed edit removes the chair resource and its prop; only the undo history still owns it.
    const stripped = workspace.project();
    stripped.resources = [];
    stripped.entities = stripped.entities.filter(e => !e.external);
    workspace.begin(stripped); workspace.commit(stripped);
    assert.equal(workspace.undoStack.length, 1);
    assert.equal((workspace.project().resources ?? []).length, 0, 'the current document no longer owns the chair source');
    const editor = buildEditor(workspace, models, chairProject);
    editor.hooks.present = () => { throw Error('演示失败'); };
    const outcome = applyWholeDocument(editor.ports, bearDoc, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(outcome.status, 'rolled-back');
    if (outcome.status !== 'rolled-back') throw new Error('unreachable');
    // Undo across the reinstated session reaches the document that still owns the chair resource.
    const undone = workspace.undo(workspace.project());
    assert.equal((undone!.resources ?? []).length, 1, 'the history-only resource returns through undo');
    // And it is a real, working model — not a restored reference to a disposed source.
    models.assertReady(projectForScene(chairDoc));
    const prop = projectForScene(chairDoc).entities.find(e => e.external)!;
    const root = models.create(prop);
    assert.ok(root.children.length > 0, 'the history-only model really instantiates');
    models.sample(prop, false, 0);
    models.removeInstance(prop.id);
    assert.throws(() => models.assertReady(projectForScene(bearDoc)), /模型资源加载/);
});

test('RP6-R02: the unified write gate refuses every mutating entry until cleared', () => {
    const gate = new WriteGate();
    assert.equal(gate.blocked, false);
    assert.equal(gate.denial(), null);
    gate.refuse(); // writes allowed — must not throw
    gate.block(Error('界面重建失败'));
    assert.equal(gate.blocked, true);
    assert.match(gate.denial()!, /整档回滚失败禁写状态/);
    assert.match(gate.denial()!, /界面重建失败/, 'the denial carries the rollback failure reason');
    assert.throws(() => gate.refuse(), /整档回滚失败禁写状态/);
    gate.clear();
    assert.equal(gate.denial(), null);
    gate.refuse(); // allowed again
    gate.block('普通文本原因');
    assert.match(gate.denial()!, /普通文本原因/, 'non-Error reasons are handled too');
});

function initialView(project: Project) {
    return { time: 3, preview: 'program', selected: project.entities[0].id };
}

// --- RP7: the write-blocked state cannot be bypassed by switch compensation or retries ----------

test('RP7-A9: a write-blocked apply refuses the managed switch retry after compensation and keeps the block', () => {
    const initial = demoProject();
    const workspace = new SceneWorkspace(initial, () => ({ ...initialView(initial) }));
    commitOneEdit(workspace, '工程A');
    const before = workspace.document();
    const candidate = readSceneDocument(demoProject()); candidate.name = '工程B';
    const editor = buildEditor(workspace, new SceneModels(), initial);
    editor.hooks.present = () => { throw Error('演示失败'); };
    editor.hooks.rollback = () => { throw Error('界面重建失败'); };
    // The managed switch (RP7) calls the whole-document apply; here it ends write-blocked.
    const blocked = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(blocked.status, 'write-blocked');
    // RP7 compensation restores the persisted choice and binding — none of that touches the gate
    // (the gate exposes no clear path to managed code; only clear() in tests/restart lifts it).
    const captures = editor.calls.capture;
    const retried = applyWholeDocument(editor.ports, candidate, workspace.context, '打开项目', { resetViews: true, resetHistory: true });
    assert.equal(retried.status, 'refused', 'the compensatable retry cannot bypass the WriteGate');
    assert.equal(editor.calls.capture, captures, 'the refused retry captures and changes nothing');
    assert.deepEqual(workspace.document(), before, 'the document is untouched by the refused retry');
    // The gate only clears through its explicit recovery hook — never as a side effect.
    const gate = new WriteGate();
    gate.block(Error('界面重建失败'));
    assert.equal(gate.blocked, true);
    gate.clear();
    assert.equal(gate.blocked, false, 'only the explicit recovery hook lifts the block');
});
