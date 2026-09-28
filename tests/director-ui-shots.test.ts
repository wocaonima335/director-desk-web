import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveShots, editorBusyReason, mountShotList, shotIndexAt } from '../src/director-ui/shot-list.ts';
import type { AppContext } from '../src/app-context.ts';
import { clone, demoProject, assertProject, type Project } from '../src/model.ts';
import { SceneWorkspace } from '../src/scenes/scene-workspace.ts';
import { readSceneDocument, type SceneDocument } from '../src/scenes/sequence-project.ts';

/** 最小 DOM 桩（与 director-ui-shell.test.ts 同一思路，只保留 B 模块用到的语义）：
 * append/textContent/classList/attrs/dataset/listeners/click/press/emit/focus，
 * 驱动真实 shot-list 模块逻辑；测试文件独立进程，直接替换 document。 */
class StubNode {
    parent: StubNode | null = null;
    children: StubNode[] = [];
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    className = ''; text = '';
    value = ''; disabled = false;
    listeners = new Map<string, Array<(event?: unknown) => void>>();
    _id = '';
    constructor(tag: string) { void tag; }
    get id() { return this._id; }
    set id(value: string) { this._id = value; if (value) byId.set(value, this); }
    set textContent(value: string) { for (const child of this.children) child.parent = null; this.children = []; this.text = value; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    get isConnected() { let node: StubNode | null = this; while (node.parent) node = node.parent; return node === docRoot; }
    append(...nodes: StubNode[]) { for (const node of nodes) { detach(node); node.parent = this; this.children.push(node); } }
    get classList() {
        const self = this;
        const names = () => self.className.split(/\s+/).filter(Boolean);
        return {
            add: (...added: string[]) => { self.className = [...new Set([...names(), ...added])].join(' '); },
            remove: (...removed: string[]) => { self.className = names().filter(name => !removed.includes(name)).join(' '); },
            contains: (name: string) => names().includes(name),
        };
    }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    addEventListener(type: string, handler: (event?: unknown) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler); this.listeners.set(type, list);
    }
    click() { for (const handler of [...(this.listeners.get('click') ?? [])]) handler(); }
    press(key: string, modifiers: { ctrl?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean } = {}) {
        const recorded = { prevented: 0, stopped: 0 };
        const event = {
            key, code: key === ' ' ? 'Space' : `Key_${key}`,
            ctrlKey: !!modifiers.ctrl, altKey: !!modifiers.alt, metaKey: !!modifiers.meta,
            repeat: !!modifiers.repeat,
            preventDefault: () => { recorded.prevented++; },
            stopPropagation: () => { recorded.stopped++; },
        };
        for (const handler of [...(this.listeners.get('keydown') ?? [])]) handler(event);
        return recorded;
    }
    emit(type: string, event: Record<string, unknown> = {}) {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }
    focus() { doc.activeElement = this; }
}
function detach(node: StubNode) {
    const parent = node.parent;
    if (parent) parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = null;
}
const docRoot = new StubNode('#document');
const byId = new Map<string, StubNode>();
const doc = {
    activeElement: null as StubNode | null,
    createElement: (tag: string) => new StubNode(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    body: docRoot,
};
(globalThis as Record<string, unknown>).document = doc;

/** 接通的 AppContext 形状边界：project/selected/time/playing/preview 为可写状态，
 * seek/selectEntity/renderCameras 只计数并改视图状态；applyField/change/changed 计数供零写入断言。
 * 真实 SceneWorkspace 集成见下方 useWorkspace fixture（不经此桩）。 */
function makeCtx() {
    const calls = { seek: 0, select: 0, change: 0, changed: 0, applyField: 0, renderCameras: 0, toast: 0 };
    const applied: Array<{ key: string; value: string }> = [];
    const state = { time: 0, playing: false, preview: 'program', selected: '', busy: false,
        draft: null as { id: string } | null, writeBlocked: null as string | null };
    let project: Project = demoProject();
    const ctx = {
        get project() { return project; }, set project(value: Project) { project = value; },
        get selected() { return state.selected; }, set selected(value: string) { state.selected = value; },
        get time() { return state.time; }, set time(value: number) { state.time = value; },
        get playing() { return state.playing; }, set playing(value: boolean) { state.playing = value; },
        get preview() { return state.preview; }, set preview(value: string) { state.preview = value; },
        get busy() { return state.busy; }, set busy(value: boolean) { state.busy = value; },
        get draft() { return state.draft; }, set draft(value: { id: string } | null) { state.draft = value; },
        get writeBlockedReason() { return state.writeBlocked; },
        get revision() { return 0; },
        engine: { dragging: false, exporting: false, requestResize() { } },
        history: { pending: null as Project | null },
        managed: { available: false, managedActive: false, unconfirmed: false, leaseOwned: false },
        current: () => project.entities.find(entity => entity.id === state.selected),
        seek(t: number) { calls.seek++; state.time = Math.max(0, t); },
        selectEntity(id: string) { calls.select++; state.selected = id; },
        renderCameras() { calls.renderCameras++; },
        toast() { calls.toast++; },
        applyField(key: string, value: string) { calls.applyField++; applied.push({ key, value }); },
        change(fn: () => void) { calls.change++; fn(); return true; },
        changed() { calls.changed++; },
        refuseWrite() { },
    };
    return { ctx: ctx as unknown as AppContext, calls, state, applied };
}

function mountShots(ctx: AppContext) {
    const rail = new StubNode('aside');
    const handle = mountShotList(rail as unknown as HTMLElement, ctx);
    const list = rail.children.find(node => node.id === 'director-shot-list')!;
    assert.ok(list, '镜头列表容器应存在');
    const cards = () => list.children;
    return { rail, handle, cards };
}

test('deriveShots：真实切镜派生区间，重复机位不合并，末镜到 duration', () => {
    const project = demoProject();
    const cameras = project.entities.filter(entity => entity.kind === 'camera');
    const shots = deriveShots(project);
    assert.equal(shots.length, project.cuts.length, '卡片数等于切镜数，重复机位不合并');
    assert.deepEqual(shots.map(shot => [shot.start, shot.end]), [[0, 5], [5, 10], [10, 15]]);
    assert.equal(shots[0].camera, cameras[0], '第 1 镜机位 A');
    assert.equal(shots[1].camera, cameras[1], '第 2 镜机位 B');
    assert.equal(shots[2].camera, cameras[0], '第 3 镜重复使用机位 A，仍是一张独立卡');
    assert.deepEqual(shots.map(shot => shot.index), [0, 1, 2]);
});

test('shotIndexAt：切点归下一卡，time===duration 标记末卡，空切镜与缺失机位不抛出', () => {
    const shots = deriveShots(demoProject());
    assert.equal(shotIndexAt(shots, 0), 0);
    assert.equal(shotIndexAt(shots, 4.9), 0);
    assert.equal(shotIndexAt(shots, 5), 1, '切点 5s 归下一卡');
    assert.equal(shotIndexAt(shots, 9.99), 1);
    assert.equal(shotIndexAt(shots, 10), 2);
    assert.equal(shotIndexAt(shots, 15), 2, 'time===duration 标记末卡');
    assert.equal(shotIndexAt(shots, -1), 0);
    const empty = deriveShots({ ...demoProject(), cuts: [] });
    assert.equal(empty.length, 1);
    assert.equal(empty[0].camera, null, '无切镜数据显示不可用，不伪造');
    const broken = deriveShots({ ...demoProject(), cuts: [{ time: 0, cameraId: 'missing-camera' }] });
    assert.equal(broken[0].camera, null);
    assert.equal(editorBusyReason === undefined, false);
});

test('卡片点击：busy/draft/pending/dragging/exporting 中全部拒绝，不 seek 不选中不刷机位条', () => {
    const { ctx, calls, state } = makeCtx();
    const { cards } = mountShots(ctx);
    state.playing = true;
    const guards: Array<[string, () => void]> = [
        ['busy', () => { state.busy = true; }],
        ['draft', () => { state.draft = { id: 'x' }; }],
        ['pending', () => { (ctx.history as { pending: unknown }).pending = demoProject(); }],
        ['dragging', () => { (ctx.engine as unknown as { dragging: boolean }).dragging = true; }],
        ['exporting', () => { (ctx.engine as unknown as { exporting: boolean }).exporting = true; }],
    ];
    for (const [name, arm] of guards) {
        const before = { ...calls };
        arm();
        cards()[1].click(); // 第二张卡：若未拦截会 seek(5) + 选中 B，并在 draft 下连带 finishPath
        assert.equal(calls.seek, before.seek, `${name} 中不得 seek`);
        assert.equal(calls.select, before.select, `${name} 中不得选中（避免 draft 下 selectEntity→finishPath）`);
        assert.equal(calls.renderCameras, before.renderCameras, `${name} 中不得刷机位条`);
        assert.equal(calls.toast, before.toast + 1, `${name} 中拒绝必须有提示`);
        // 解除
        state.busy = false; state.draft = null;
        (ctx.history as { pending: unknown }).pending = null;
        (ctx.engine as unknown as { dragging: boolean }).dragging = false;
        (ctx.engine as unknown as { exporting: boolean }).exporting = false;
    }
});

test('正常点击：停播放、成片预览、seek 区间起点、选中摄影机；change/changed 零调用', () => {
    const { ctx, calls, state } = makeCtx();
    const { cards } = mountShots(ctx);
    const cameraA = ctx.project.entities.filter(entity => entity.kind === 'camera')[0];
    state.playing = true;
    state.preview = 'some-camera';
    state.time = 12;
    cards()[2].click(); // 第 3 镜：10–15，机位 A
    assert.equal(state.playing, false, '点击必须停止播放');
    assert.equal(state.preview, 'program', '预览切回成片');
    assert.equal(calls.seek, 1);
    assert.equal(state.time, 10, '定位到区间起点 10s');
    assert.equal(state.selected, cameraA.id, '选中该镜摄影机');
    assert.equal(calls.select, 1);
    assert.equal(calls.renderCameras, 1, '视图刷新走既有 renderCameras 入口');
    assert.equal(calls.change + calls.changed, 0, '不调用 change/changed');
    assert.equal(calls.applyField, 0);
});

test('镜头卡片 Space/Enter 先隔离再激活，repeat 拒绝且不落回全局播放', () => {
    const { ctx, calls, state } = makeCtx();
    const { cards } = mountShots(ctx);
    const card = cards()[1];
    const first = card.press(' ');
    assert.ok(first.prevented >= 1 && first.stopped >= 1, 'Space 先 preventDefault + stopPropagation 隔离全局播放');
    assert.equal(calls.seek, 1, '一次 Space 恰好激活一次（seek 到 5s）');
    assert.equal(state.time, 5);
    const repeated = card.press(' ', { repeat: true });
    assert.ok(repeated.prevented >= 1 && repeated.stopped >= 1, 'repeat 事件同样先隔离');
    assert.equal(calls.seek, 1, 'repeat 不重复激活，也不触发全局播放');
    const enter = card.press('Enter');
    assert.ok(enter.prevented >= 1 && enter.stopped >= 1);
    assert.equal(calls.seek, 2, 'Enter 一次激活');
    const other = card.press('ArrowLeft');
    assert.equal(other.prevented + other.stopped, 0, '非激活键不拦截');
    assert.equal(calls.seek, 2);
});

test('播放推进只更新当前标记：节点不重建、不抢焦点', () => {
    const { ctx } = makeCtx();
    const { handle, cards } = mountShots(ctx);
    const snapshot = () => [...cards()];
    doc.activeElement = null;
    assert.equal(cards()[0].classList.contains('director-shot-current'), true, '初始标记第 1 镜');
    const before = snapshot();
    ctx.time = 3; // 播放推进：区间不变
    handle.refreshMarker();
    assert.deepEqual(snapshot(), before, '同一区间内推进不重建任何卡片节点');
    ctx.time = 6; // 跨过切点：标记移到第 2 镜
    handle.refreshMarker();
    const after = snapshot();
    assert.equal(after[0].classList.contains('director-shot-current'), false);
    assert.equal(after[1].classList.contains('director-shot-current'), true, '标记移到第 2 镜');
    assert.deepEqual(after, before, '跨切点也只改标记，不重建节点');
    assert.equal(doc.activeElement, null, '刷新从不调用 focus');
    ctx.time = 15; // 末卡
    handle.refreshMarker();
    assert.equal(cards()[2].classList.contains('director-shot-current'), true, 'time===duration 标记末卡');
});

test('refresh：切镜数据变化才重建；内容未变时保持节点；异常数据显示不可用', () => {
    const { ctx } = makeCtx();
    const { handle, cards } = mountShots(ctx);
    const before = [...cards()];
    handle.refresh(); // 无变化：不重建
    assert.deepEqual([...cards()], before);
    ctx.project.entities.find(entity => entity.kind === 'camera')!.name = 'A · 已改名';
    handle.refresh(); // 机位名变化：重建一次
    assert.match(cards()[0].textContent, /A · 已改名/);
    assert.notEqual(cards()[0], before[0], '数据变化后重建节点');
    // 缺失机位的切镜：卡片显示不可用，不伪造名称
    const broken = makeCtx();
    const brokenProject = demoProject();
    const cameras = brokenProject.entities.filter(entity => entity.kind === 'camera');
    brokenProject.cuts = [{ time: 0, cameraId: 'ghost' }, { time: 15, cameraId: cameras[0].id }];
    (broken.ctx as unknown as { project: Project }).project = brokenProject;
    const brokenHandle = mountShots(broken.ctx);
    assert.match(brokenHandle.cards()[0].textContent, /机位不可用/);
    assert.match(brokenHandle.cards()[1].textContent, /时长不可用/, '起点即 duration 的异常切镜时长显示不可用');
    void brokenHandle.handle.refresh();
});

/** 真实 SceneWorkspace fixture：与生产 main.ts 相同的 change/undo 语义（begin→fn→assert→commit，
 * 失败 rollback），view 回调按生产形状；不桩化 SceneWorkspace/SceneSession 本身。 */
function useWorkspace() {
    const base = demoProject();
    const first = readSceneDocument(clone(base));
    const stateB = clone(first.scenes[0].state);
    const camerasB = stateB.entities.filter(entity => entity.kind === 'camera');
    stateB.cuts = [{ time: 0, cameraId: camerasB[1].id }, { time: 8, cameraId: camerasB[2].id }];
    const document: SceneDocument = readSceneDocument({
        ...first,
        scenes: [...first.scenes, { id: 'scene-b', name: '第二场 · 补拍', state: stateB }],
    });
    const view = { time: 0, selected: '', preview: 'program' };
    // SceneWorkspace 构造签名按 Project 标注，运行时经 readSceneDocument 接受整份 SceneDocument（与生产一致）
    const history = new SceneWorkspace(document as unknown as Project, () => ({ ...view }));
    let project = history.project();
    let revision = 0;
    const state = { busy: false, draft: null as { id: string } | null, playing: false, preview: 'program', selected: '' };
    function change(fn: () => void): boolean {
        if (state.busy || state.draft || history.pending) return false;
        history.begin(project);
        try {
            fn();
            assertProject(project);
            history.commit(project);
            revision++;
            return true;
        } catch {
            project = history.rollback() ?? project;
            state.selected = history.restoredSelection || state.selected;
            return false;
        }
    }
    const calls = { applyField: 0, change: 0, changed: 0, seek: 0, select: 0, toast: 0 };
    const ctx = {
        get project() { return project; }, set project(value: Project) { project = value; },
        get selected() { return state.selected; }, set selected(value: string) { state.selected = value; },
        get time() { return view.time; }, set time(value: number) { view.time = value; },
        get playing() { return state.playing; }, set playing(value: boolean) { state.playing = value; },
        get preview() { return state.preview; }, set preview(value: string) { state.preview = value; },
        get busy() { return state.busy; }, set busy(value: boolean) { state.busy = value; },
        get draft() { return state.draft; }, set draft(value: { id: string } | null) { state.draft = value; },
        get writeBlockedReason() { return null; },
        get revision() { return revision; },
        engine: { dragging: false, exporting: false, requestResize() { } },
        history, scenes: history,
        managed: { available: false, managedActive: false, unconfirmed: false, leaseOwned: false },
        current: () => project.entities.find(entity => entity.id === state.selected),
        seek(t: number) { calls.seek++; view.time = Math.max(0, t); },
        selectEntity(id: string) { calls.select++; state.selected = id; },
        renderCameras() { },
        toast() { calls.toast++; },
        applyField() { calls.applyField++; },
        change(fn: () => void) { calls.change++; return change(fn); },
        changed() { calls.changed++; revision++; },
        refuseWrite() { },
    };
    return { ctx: ctx as unknown as AppContext, history, change, camerasB };
}

test('真实 SceneWorkspace：切镜编辑入历史、undo 后列表回到 3 镜（内容级断言，不只计数）', () => {
    const { ctx, history, change } = useWorkspace();
    const { handle, cards } = mountShots(ctx);
    assert.equal(cards().length, 3);
    const cameraC = ctx.project.entities.filter(entity => entity.kind === 'camera')[2];
    const undoCountBefore = history.undoStack.length;
    // 切镜按时间有序插入（与生产时间轴插入语义一致，assertProject 要求严格递增）
    const committed = change(() => {
        const cuts = ctx.project.cuts;
        const at = cuts.findIndex(cut => cut.time > 7.5);
        cuts.splice(at < 0 ? cuts.length : at, 0, { time: 7.5, cameraId: cameraC.id });
    });
    assert.equal(committed, true, '真实 change 通过 assertProject 校验并提交');
    assert.equal(history.undoStack.length, undoCountBefore + 1, '恰好一个撤销点');
    handle.refresh();
    assert.equal(cards().length, 4, '新切镜立即派生第 4 镜');
    assert.match(cards()[2].textContent, /7\.5 秒 – 10\.0 秒/, '按时间有序插入后新镜从 7.5s 起');
    // 真实 undo：项目内容回到 3 条切镜，列表随之回到 3 镜
    const undone = history.undo(ctx.project);
    assert.ok(undone, 'undo 返回工程');
    assert.equal(undone.cuts.length, 3, 'undo 后工程切镜数据真实恢复');
    ctx.project = undone;
    handle.refresh();
    assert.equal(cards().length, 3);
    assert.doesNotMatch(cards()[2].textContent, /7\.5 秒/);});

test('真实 SceneWorkspace：切换戏段后按新戏段切镜重派生', () => {
    const { ctx, history } = useWorkspace();
    const { handle, cards } = mountShots(ctx);
    assert.equal(cards().length, 3);
    history.switchScene('scene-b', history.context);
    const next = history.project();
    assert.equal(next.cuts.length, 2, 'scene-b 真实只有两条切镜');
    ctx.project = next;
    handle.refresh();
    assert.equal(cards().length, 2);
    const cameraB = ctx.project.entities.filter(entity => entity.kind === 'camera')[1];
    const cameraC = ctx.project.entities.filter(entity => entity.kind === 'camera')[2];
    assert.match(cards()[0].textContent, new RegExp(cameraB.name.replaceAll('.', '\\.')));
    assert.match(cards()[1].textContent, new RegExp(cameraC.name.replaceAll('.', '\\.')));
    // 切回第一场：3 镜恢复
    history.switchScene('scene-main', history.context);
    ctx.project = history.project();
    handle.refresh();
    assert.equal(cards().length, 3);
});
