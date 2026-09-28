import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSimpleProperties } from '../src/director-ui/simple-properties.ts';
import { mountTaskStatus } from '../src/director-ui/task-status.ts';
import type { AppContext } from '../src/app-context.ts';
import { assertProject, clone, demoProject, type Project } from '../src/model.ts';
import { createEditingTools } from '../src/editor/operations.ts';
import { SceneWorkspace } from '../src/scenes/scene-workspace.ts';
import { readSceneDocument } from '../src/scenes/sequence-project.ts';

/** 最小 DOM 桩（与 director-ui-shell.test.ts 同一思路）：只保留 B 模块用到的语义，
 * 驱动真实 simple-properties / task-status 模块逻辑；测试独立进程，直接替换 document。 */
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

function buildStatusDom() {
    byId.clear(); doc.activeElement = null;
    const saveStatus = new StubNode('span'); saveStatus.id = 'save-status'; saveStatus.textContent = '本地项目';
    const aspect = new StubNode('select'); aspect.id = 'aspect';
    const duration = new StubNode('input'); duration.id = 'duration';
    docRoot.append(saveStatus, aspect, duration);
    byId.set('save-status', saveStatus); byId.set('aspect', aspect); byId.set('duration', duration);
    return { saveStatus, aspect, duration };
}

/** 真实编辑 fixture：SceneWorkspace / createEditingTools 均为生产模块，不桩化。
 * change 复刻生产 main.ts 语义（begin→fn→assertProject→commit，失败 rollback），
 * ctx.applyField 接到真实 tools.applyField；engine 相关成员只提供模块读取的形状。
 * document 参数默认为 demoProject 迁移出的单戏段文档；B-R01 跨戏段用例传入双戏段文档。 */
function makeEditorFixture(document: Project = readSceneDocument(clone(demoProject())) as unknown as Project) {
    buildStatusDom();
    const state = { time: 0, selected: '', busy: false, draft: null as { id: string } | null,
        playing: false, preview: 'program', writeBlocked: null as string | null };
    const history = new SceneWorkspace(document,
        () => ({ time: state.time, selected: state.selected, preview: state.preview }));
    let project: Project = history.project();
    let revision = 0;
    let dirty = false;
    const calls = { applyField: 0, change: 0, changed: 0, toast: 0 };
    const toasts: Array<{ message: string; error: boolean }> = [];
    function change(fn: () => void, rebuild = true): boolean {
        calls.change++;
        if (state.busy) return false;
        if (state.writeBlocked) { toasts.push({ message: state.writeBlocked, error: true }); return false; }
        if (state.draft || history.pending) { toasts.push({ message: '请先完成或取消当前绘制／拖动操作', error: true }); return false; }
        state.playing = false;
        history.begin(project);
        try {
            fn();
            assertProject(project);
            history.commit(project);
            revision++; dirty = true;
            void rebuild;
            return true;
        } catch (error) {
            project = history.rollback() ?? project;
            state.selected = history.restoredSelection || state.selected;
            toasts.push({ message: (error as Error).message, error: true });
            return false;
        }
    }
    const ctx = {
        get project() { return project; }, set project(value: Project) { project = value; },
        get selected() { return state.selected; }, set selected(value: string) { state.selected = value; },
        get time() { return state.time; }, set time(value: number) { state.time = value; },
        get playing() { return state.playing; }, set playing(value: boolean) { state.playing = value; },
        get preview() { return state.preview; }, set preview(value: string) { state.preview = value; },
        get busy() { return state.busy; }, set busy(value: boolean) { state.busy = value; },
        get draft() { return state.draft; }, set draft(value: { id: string } | null) { state.draft = value; },
        get writeBlockedReason() { return state.writeBlocked; },
        get revision() { return revision; },
        get dirty() { return dirty; },
        engine: { dragging: false, exporting: false, requestResize() { } },
        history, scenes: history,
        managed: { available: false, managedActive: false, unconfirmed: false, leaseOwned: false },
        current: () => project.entities.find(entity => entity.id === state.selected),
        seek(t: number) { state.time = Math.max(0, t); },
        selectEntity(id: string) { state.selected = id; },
        renderCameras() { },
        renderPanels() { },
        toast(message: string, error = false) { calls.toast++; toasts.push({ message, error }); },
        applyField(key: string, value: string) { calls.applyField++; tools.applyField(key, value); },
        change,
        changed() { calls.changed++; revision++; dirty = true; },
        refuseWrite() { },
    };
    const tools = createEditingTools(ctx as unknown as AppContext);
    const cameras = () => project.entities.filter(entity => entity.kind === 'camera');
    return { ctx: ctx as unknown as AppContext, tools, calls, state, toasts, history, cameras, getProject: () => project };
}

function mountProperties(ctx: AppContext) {
    let requestAdvancedCalls = 0;
    const rail = new StubNode('aside');
    const handle = mountSimpleProperties(rail as unknown as HTMLElement, ctx, {
        requestAdvanced: () => { requestAdvancedCalls++; },
    });
    const find = (id: string) => {
        const direct = rail.children.find(node => node.id === id);
        if (direct) return direct;
        for (const node of rail.children) {
            const inner = node.children.find(child => child.id === id);
            if (inner) return inner;
        }
        throw new Error(`未找到节点 ${id}`);
    };
    return {
        rail, handle,
        summary: find('director-shot-summary'),
        input: find('director-focal-input') as StubNode,
        apply: find('director-focal-apply'),
        scopeNote: find('director-scope-note'),
        locate: find('director-scope-locate'),
        actions: find('director-action-list'),
        lock: find('director-lock-note'),
        requestAdvancedCount: () => requestAdvancedCalls,
    };
}

test('属性栏：景别固定未标注、切镜时长只读、机位与焦距显示真实数据', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    fixture.state.selected = fixture.cameras()[0].id; // 与显示机位一致
    ui.handle.refresh();
    const text = ui.rail.textContent;
    assert.match(text, /景别：未标注（本版本不推断景别）/);
    assert.match(text, /切镜时长（只读）：5\.0 秒/);
    assert.match(text, /摄影机：A · 室内全景/);
    assert.equal(ui.input.value, '20', '输入框初值为当前镜头真实焦距');
    assert.match(text, /被 2 个镜头共用/, '机位 A 被两处切镜共用需提示共同生效');
    // 时间进入第 2 镜：显示随区间变化
    fixture.state.time = 6;
    ui.handle.refresh();
    assert.match(ui.rail.textContent, /摄影机：B · 人物跟拍/);
    assert.equal(ui.input.value, '28');
    assert.match(ui.rail.textContent, /切镜时长（只读）：5\.0 秒/);
});

test('焦距一次编辑一个撤销点：真实 createEditingTools 写入，真实 SceneWorkspace undo 还原数值', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    const cameraA = fixture.cameras()[0];
    fixture.state.selected = cameraA.id;
    ui.handle.refresh();
    ui.input.value = '50';
    const undoBefore = fixture.history.undoStack.length;
    ui.apply.click();
    assert.equal(fixture.calls.applyField, 1, '一次完成编辑只调用一次 applyField');
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 50, '真实写入工程数据');
    assert.equal(fixture.history.undoStack.length, undoBefore + 1, '恰好产生一个撤销点');
    assert.equal(ui.input.value, '50');
    // 真实 undo（对应生产 Ctrl+Z → commands.act('undo') 路径）：数值必须真正还原
    const undone = fixture.history.undo(fixture.getProject());
    assert.ok(undone);
    assert.equal(undone.entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, 'undo 后焦距数据真实还原');
    fixture.ctx.project = undone;
    fixture.ctx.changed(); // 生产 undo 命令会调用 changed() → renderPanels → 刷新
    ui.handle.refresh();
    assert.equal(ui.input.value, '20', '撤销后属性栏显示还原后的焦距');
    // 未变化值不产生撤销点
    ui.apply.click();
    assert.equal(fixture.calls.applyField, 1, '焦距未变化时不提交');
    assert.equal(fixture.history.redoStack.length, 1, 'undo 后重做栈保留该编辑');
});

test('保护拒绝：禁写/锁定/目标未选中/目标过期/busy/draft/pending 都不写入', () => {
    const fixture = makeEditorFixture();
    const cameraA = fixture.cameras()[0];
    const attempt = (ui: ReturnType<typeof mountProperties>, value = '50') => {
        const before = fixture.calls.applyField;
        const undoBefore = fixture.history.undoStack.length;
        ui.input.value = value;
        ui.apply.click();
        assert.equal(fixture.calls.applyField, before, '不得调用 applyField');
        assert.equal(fixture.history.undoStack.length, undoBefore, '不得产生撤销点');
        assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, '工程数据不变');
    };
    // 目标未选中（selected 为空，与显示机位不一致）
    const ui1 = mountProperties(fixture.ctx);
    attempt(ui1);
    assert.match(fixture.toasts.at(-1)!.message, /选中其摄影机/);
    // 过期/冲突目标：选中了另一台摄影机
    fixture.state.selected = fixture.cameras()[2].id;
    ui1.handle.refresh();
    attempt(ui1);
    assert.match(fixture.toasts.at(-1)!.message, /选中其摄影机|重新选择/);
    // 整档禁写
    fixture.state.selected = cameraA.id;
    fixture.state.writeBlocked = '整档回滚失败 · 已禁写';
    ui1.handle.refresh();
    attempt(ui1);
    assert.match(fixture.toasts.at(-1)!.message, /整档回滚失败/);
    fixture.state.writeBlocked = null;
    // busy / draft / pending（pending 用真实 SceneWorkspace 事务）
    const arms: Array<[() => void, () => void]> = [
        [() => { fixture.state.busy = true; }, () => { fixture.state.busy = false; }],
        [() => { fixture.state.draft = { id: cameraA.id }; }, () => { fixture.state.draft = null; }],
        [() => { fixture.history.begin(fixture.getProject()); }, () => { fixture.history.rollback(); }],
    ];
    for (const [arm, disarm] of arms) {
        arm();
        attempt(ui1);
        assert.match(fixture.toasts.at(-1)!.message, /暂不可修改|完成或取消/);
        disarm();
    }
    // 锁定机位：模块拒绝，真实 applyField 的 locked 分支也不触达
    cameraA.locked = true;
    ui1.handle.refresh();
    attempt(ui1);
    assert.match(fixture.toasts.at(-1)!.message, /已锁定/);
    cameraA.locked = false;
    // 越界与非数值：不写入
    attempt(ui1, '500');
    assert.match(fixture.toasts.at(-1)!.message, /8 到 300/);
    attempt(ui1, 'abc');
    assert.match(fixture.toasts.at(-1)!.message, /8 到 300/);
});

test('刷新不覆盖未提交输入、不抢焦点；换镜头后旧输入随目标更新', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    ui.handle.refresh();
    assert.equal(ui.input.value, '20');
    ui.input.value = '50';
    ui.input.emit('input'); // 用户已编辑未提交
    fixture.ctx.changed(); // 文档变化触发刷新（revision 变化）
    ui.handle.refresh();
    assert.equal(ui.input.value, '50', '未提交输入不被刷新覆盖');
    // 聚焦中的输入同样不覆盖，且焦点不被移动
    doc.activeElement = ui.input;
    ui.input.value = '45';
    ui.handle.refresh();
    assert.equal(ui.input.value, '45', '聚焦中的输入不被覆盖');
    assert.equal(doc.activeElement, ui.input, '刷新不移动焦点');
    doc.activeElement = null;
    // 换镜头（时间跨切点）：旧输入属于旧目标，允许覆写为新机位焦距
    fixture.state.time = 6;
    ui.handle.refresh();
    assert.equal(ui.input.value, '28', '目标变化后显示新机位焦距');
});

test('戏段作用域与定位原控件：说明作用于整个戏段，定位按钮请求高级并聚焦 #aspect', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    const text = ui.rail.textContent;
    assert.match(text, /当前戏段总时长 15\.0 秒 · 画幅 16:9/);
    assert.match(text, /作用于整个当前戏段，不是单个镜头/);
    assert.match(text, /调整请使用原控件/);
    ui.locate.click();
    assert.equal(ui.requestAdvancedCount(), 1, '定位复用壳层既有模式切换，不复制控件');
    assert.equal(doc.activeElement, byId.get('aspect'), '定位后聚焦原画幅控件');
    // 键盘：Space 一次激活并隔离，repeat 拒绝
    doc.activeElement = null;
    const first = ui.locate.press(' ');
    assert.ok(first.prevented >= 1 && first.stopped >= 1, 'Space 先隔离全局播放');
    assert.equal(doc.activeElement, byId.get('aspect'));
    doc.activeElement = null;
    const repeated = ui.locate.press(' ', { repeat: true });
    assert.ok(repeated.prevented >= 1 && repeated.stopped >= 1, 'repeat 同样隔离');
    assert.equal(doc.activeElement, null, 'repeat 不重复激活');
});

test('人物动作汇总：区间内真实 clips 与 clipLabel，注明不代表都在画面内；锁定注明不是工作流审批', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    fixture.state.selected = fixture.cameras()[0].id;
    ui.handle.refresh();
    const text = ui.rail.textContent;
    assert.match(text, /不代表都在画面内/);
    assert.match(text, /人物 A · 床边：坐姿/, 'clipLabel(c) 真实标签（sit 0–7 与 [0,5) 有正长度交集）');
    assert.match(text, /人物 B · 走向衣柜：站立 \/ 待机/, 'idle 0–2');
    assert.match(text, /人物 B · 走向衣柜：走路/, 'walk 2–6 与区间有正长度交集');
    assert.match(text, /人物 C · 书桌：坐姿/);
    assert.match(text, /人物 D · 进门：走路/);
    assert.doesNotMatch(text, /人物 B · 走向衣柜：转身/, 'turn 6–8 与第 1 镜无交集不得出现');
    assert.match(ui.lock.textContent, /当前镜头摄影机未锁定/);
    assert.match(ui.lock.textContent, /不是工作流审批/);
    fixture.cameras()[0].locked = true;
    ui.handle.refresh();
    assert.match(ui.lock.textContent, /已锁定/);
    assert.match(ui.lock.textContent, /不是工作流审批/);
});

test('挂载即渲染零写入：属性栏与状态区挂载不调用 applyField/change/changed', () => {
    const fixture = makeEditorFixture();
    mountProperties(fixture.ctx);
    const note = new StubNode('div');
    mountTaskStatus(note as unknown as HTMLElement, fixture.ctx);
    assert.equal(fixture.calls.applyField + fixture.calls.change + fixture.calls.changed, 0);
    assert.equal(fixture.toasts.length, 0);
});

function mountStatus(ctx: AppContext) {
    const note = new StubNode('div');
    const handle = mountTaskStatus(note as unknown as HTMLElement, ctx);
    const walk = function* (node: StubNode): Generator<StubNode> {
        yield node;
        for (const child of node.children) yield* walk(child);
    };
    const all = [...walk(note)];
    const lines = all.find(node => node.id === 'director-status-lines')!;
    const row = (name: string) => {
        const found = lines.children.find(node => node.dataset.directorStatus === name);
        if (!found) throw new Error(`未找到状态行 ${name}`);
        return found;
    };
    const send = all.find(node => node.id === 'director-draft-send')!;
    const draft = all.find(node => node.id === 'director-draft-input')!;
    return { note, handle, send, draft, row };
}

test('状态区：固定模拟模式文案、草稿提交禁用且零模型/零工程调用', () => {
    const fixture = makeEditorFixture();
    const ui = mountStatus(fixture.ctx);
    assert.match(ui.note.textContent, /模拟模式 · 未运行工作流/);
    assert.match(ui.note.textContent, /不会调用模型，也不修改工程/);
    assert.equal(ui.send.disabled, true, '提交禁用');
    assert.match(ui.note.textContent, /提交已停用：工作流未接入，草稿不写入工程、不调用模型/);
    ui.draft.value = '让人物 A 走到窗边';
    ui.send.click(); // 禁用按钮：真实 DOM 不触发；桩触发也必须零动作
    ui.send.press(' ');
    ui.send.press('Enter');
    ui.send.press(' ', { repeat: true });
    assert.equal(fixture.calls.applyField + fixture.calls.change + fixture.calls.changed, 0, '草稿路径零工程写入');
    assert.equal(ui.draft.value, '让人物 A 走到窗边', '草稿只留在本页');
});

test('状态区分列显示：禁写/受管确认/写入许可/忙碌/绘制/待提交互不冒充', () => {
    const fixture = makeEditorFixture();
    const managed = (fixture.ctx as unknown as { managed: Record<string, unknown> }).managed;
    const ui = mountStatus(fixture.ctx);
    ui.handle.refresh();
    assert.match(ui.row('gate').textContent, /整档禁写：无（可正常写入）/);
    assert.match(ui.row('managed').textContent, /项目库未启用（本地会话）/);
    assert.match(ui.row('confirm').textContent, /不适用（未使用受管项目）/);
    assert.match(ui.row('lease').textContent, /不适用（未使用受管项目）/);
    assert.match(ui.row('busy').textContent, /忙碌：否/);
    assert.match(ui.row('drawing').textContent, /路径绘制：无/);
    assert.match(ui.row('pending').textContent, /待提交编辑事务：无/);
    // 受管确认与许可：各自独立行，不互相替代
    managed.available = true; managed.managedActive = true; managed.leaseOwned = false; managed.unconfirmed = false;
    ui.handle.refresh();
    assert.match(ui.row('managed').textContent, /受管项目：/);
    assert.match(ui.row('confirm').textContent, /无未确认状态/);
    assert.match(ui.row('lease').textContent, /未持有写入许可/);
    managed.unconfirmed = true; managed.leaseOwned = true;
    ui.handle.refresh();
    assert.match(ui.row('confirm').textContent, /未确认：此前受管操作未完成补偿，保存会被拒绝/);
    assert.match(ui.row('lease').textContent, /本会话持有写入许可/, '未确认与许可状态互不冒充');
    // 禁写原因原样显示
    fixture.state.writeBlocked = '整档回滚失败 · 已禁写';
    ui.handle.refresh();
    assert.equal(ui.row('gate').textContent, '整档禁写：整档回滚失败 · 已禁写');
    // busy/draft/pending 独立翻转
    fixture.state.busy = true; fixture.state.draft = { id: 'x' };
    fixture.history.begin(fixture.getProject());
    ui.handle.refresh();
    assert.match(ui.row('busy').textContent, /忙碌：是/);
    assert.match(ui.row('drawing').textContent, /路径绘制：进行中/);
    assert.match(ui.row('pending').textContent, /待提交编辑事务：有/);
    fixture.history.rollback();
});

test('保存状态只读回显：模块不覆盖 #save-status，也不推断保存结果', () => {
    const fixture = makeEditorFixture();
    const { saveStatus } = buildStatusDom();
    const ui = mountStatus(fixture.ctx);
    ui.handle.refresh();
    assert.equal(saveStatus.textContent, '本地项目', '模块不写原状态栏');
    assert.match(ui.row('save').textContent, /保存状态（只读）：本地项目/);
    saveStatus.textContent = '正在保存恢复副本…'; // 生产 changed() 写入
    ui.handle.refresh();
    assert.match(ui.row('save').textContent, /保存状态（只读）：正在保存恢复副本…/, '原样回显，不从 dirty/busy 推断');
    saveStatus.textContent = '受管状态未确认';
    ui.handle.refresh();
    assert.match(ui.row('save').textContent, /受管状态未确认/);
    assert.equal(saveStatus.textContent, '受管状态未确认', '回显后原状态栏保持原样');
    // 禁写与保存状态同时存在：两行独立
    fixture.state.writeBlocked = '整档回滚失败 · 已禁写';
    ui.handle.refresh();
    assert.equal(ui.row('gate').textContent, '整档禁写：整档回滚失败 · 已禁写');
    assert.match(ui.row('save').textContent, /受管状态未确认/);
});

/** B-R01 跨戏段文档：scene-main + scene-b（scene-main 状态的克隆，机位 ID 完全相同），
 * 经真实 readSceneDocument 校验，模拟“切到另一个戏段里同 ID 的摄影机”。 */
function twoSceneDocument(): Project {
    const first = readSceneDocument(clone(demoProject()));
    const stateB = clone(first.scenes[0].state);
    return readSceneDocument({
        ...first,
        scenes: [...first.scenes, { id: 'scene-b', name: '第二场 · 补拍', state: stateB }],
    }) as unknown as Project;
}

test('B-R01：输入开始后同机位焦距被其他真实编辑改变，提交旧值被拒绝；重新确认后一次编辑一个撤销点', () => {
    const fixture = makeEditorFixture();
    const ui = mountProperties(fixture.ctx);
    const cameraA = fixture.cameras()[0];
    fixture.state.selected = cameraA.id;
    ui.handle.refresh();
    ui.input.value = '50';
    ui.input.emit('input'); // 输入开始：记录当前戏段 + cameraA + 基准焦距 20
    // 其他编辑经真实 createEditingTools 改掉同一机位的焦距（生产语义：revision+1、dirty、一个撤销点）
    fixture.ctx.applyField('camera.focal', '33');
    assert.equal(fixture.calls.applyField, 1, '其他编辑经真实 applyField 写入');
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 33);
    const before = {
        apply: fixture.calls.applyField, undo: fixture.history.undoStack.length,
        revision: fixture.ctx.revision, dirty: fixture.ctx.dirty,
    };
    ui.apply.click(); // 提交输入开始时记录的旧值
    assert.match(fixture.toasts.at(-1)!.message, /过期.*重新输入并确认/, '必须提示重新确认');
    assert.equal(fixture.calls.applyField, before.apply, '旧输入不得再次提交');
    assert.equal(fixture.history.undoStack.length, before.undo, '拒绝不产生撤销点');
    assert.equal(fixture.ctx.revision, before.revision, '拒绝不推进 revision');
    assert.equal(fixture.ctx.dirty, before.dirty, '拒绝不改变 dirty');
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 33, '工程数据不变');
    assert.equal(ui.input.value, '33', '旧输入作废后恢复显示当前真实焦距');
    // 重新输入（新基准 33）后正常提交：恰好一次 applyField、一个真实撤销点
    ui.input.value = '45';
    ui.input.emit('input');
    ui.apply.click();
    assert.equal(fixture.calls.applyField, before.apply + 1, '重新确认后恰好一次提交');
    assert.equal(fixture.history.undoStack.length, before.undo + 1, '一次成功编辑恰好一个撤销点');
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 45, '真实写入工程数据');
});

test('B-R01：同 ID 机位跨戏段，旧输入在切换戏段后同样被拒绝', () => {
    const fixture = makeEditorFixture(twoSceneDocument());
    const ui = mountProperties(fixture.ctx);
    const cameraA = fixture.cameras()[0];
    fixture.state.selected = cameraA.id;
    ui.handle.refresh();
    ui.input.value = '50';
    ui.input.emit('input'); // 输入开始于 scene-main
    assert.equal(fixture.history.context.sceneId, 'scene-main');
    // 真实 SceneWorkspace 切换戏段：scene-b 存在同 ID 机位，仅凭 camera id 比较无法区分
    fixture.history.switchScene('scene-b', fixture.history.context);
    fixture.ctx.project = fixture.history.project();
    ui.handle.refresh();
    assert.equal(fixture.history.context.sceneId, 'scene-b');
    assert.ok(fixture.getProject().entities.some(entity => entity.id === cameraA.id && entity.kind === 'camera'),
        '同 ID 机位在当前戏段真实存在（跨戏段旧输入的判别场景）');
    const before = {
        apply: fixture.calls.applyField, undo: fixture.history.undoStack.length,
        revision: fixture.ctx.revision, dirty: fixture.ctx.dirty,
    };
    ui.apply.click();
    assert.match(fixture.toasts.at(-1)!.message, /过期.*重新输入并确认/, '跨戏段旧输入必须提示重新确认');
    assert.equal(fixture.calls.applyField, before.apply, '跨戏段旧输入不得提交');
    assert.equal(fixture.history.undoStack.length, before.undo, '拒绝不产生撤销点（切换本身的历史不计入）');
    assert.equal(fixture.ctx.revision, before.revision);
    assert.equal(fixture.ctx.dirty, before.dirty);
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, '当前戏段同 ID 机位数据不变');
    // 在当前戏段重新确认后可正常提交一次
    ui.input.value = '66';
    ui.input.emit('input');
    ui.apply.click();
    assert.equal(fixture.calls.applyField, before.apply + 1);
    assert.equal(fixture.history.undoStack.length, before.undo + 1, '一次成功编辑恰好一个撤销点');
    assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 66, '写入当前戏段的同 ID 机位');
});

test('B-R01：history.replace 打开另一合法文档后，同身份旧焦距输入被拒绝；真实 undo 只还原焦距不回滚“打开工程”', () => {
    // 覆盖两种时序：替换后先刷新再提交、替换后不刷新直接提交
    for (const refreshAfterOpen of [false, true]) {
        const fixture = makeEditorFixture();
        const ui = mountProperties(fixture.ctx);
        const cameraA = fixture.cameras()[0];
        fixture.state.selected = cameraA.id;
        ui.handle.refresh();
        // 旧文档上开始输入：记录当时的 ctx.project 引用作为复查基准
        ui.input.value = '50';
        ui.input.emit('input');
        const oldProject = fixture.ctx.project;
        const sessionIdBefore = fixture.history.context.sessionId;
        // 经真实 history.replace 打开另一合法文档并赋回 ctx.project：
        // 替换前后 sessionId、sceneId、cameraId、焦距全部相同，仅 ctx.project 引用与文档名称可区分
        const opened = fixture.history.replace(
            { ...fixture.history.document(), name: '第二份 · 已打开文档' },
            fixture.history.context, '打开另一份合法文档');
        fixture.ctx.project = opened;
        assert.notEqual(fixture.ctx.project, oldProject, 'ctx.project 引用确实变化（判别前提）');
        assert.equal(fixture.history.context.sessionId, sessionIdBefore, 'sessionId 不变（同一会话）');
        assert.equal(fixture.history.context.sceneId, 'scene-main', '活动戏段不变');
        assert.equal(fixture.getProject().name, '第二份 · 已打开文档', '新文档内容可区分');
        assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, '同 ID 机位焦距不变');
        // 打开完成并完成必要视图恢复（对应生产 restoreSceneView：time/selected/preview 取自 restoredView）
        const view = fixture.history.restoredView!;
        fixture.state.time = view.time;
        fixture.state.selected = view.selected;
        fixture.state.preview = view.preview;
        assert.equal(fixture.state.selected, cameraA.id, '视图恢复后仍选中同 ID 机位');
        if (refreshAfterOpen) ui.handle.refresh(); // 刷新不得把旧输入悄悄绑到新文档
        // 基线：打开与视图恢复完成后记录
        const before = {
            apply: fixture.calls.applyField, undo: fixture.history.undoStack.length,
            revision: fixture.ctx.revision, dirty: fixture.ctx.dirty,
        };
        ui.apply.click(); // 提交旧文档上开始的旧输入
        assert.equal(fixture.calls.applyField, before.apply, '旧输入不得提交');
        assert.equal(fixture.history.undoStack.length, before.undo, '拒绝不产生撤销点');
        assert.equal(fixture.ctx.revision, before.revision, '拒绝不推进 revision');
        assert.equal(fixture.ctx.dirty, before.dirty, '拒绝不改变 dirty');
        assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, '新工程焦距不变');
        assert.equal(fixture.getProject().name, '第二份 · 已打开文档', '拒绝不影响已打开的新文档');
        assert.match(fixture.toasts.at(-1)!.message, /过期.*重新输入并确认/, '沿用既有过期提示规则');
        // 重新输入后恰好一次提交：一个真实撤销点
        ui.input.value = '45';
        ui.input.emit('input');
        ui.apply.click();
        assert.equal(fixture.calls.applyField, before.apply + 1, '重新输入后恰好一次 applyField');
        assert.equal(fixture.history.undoStack.length, before.undo + 1, 'undo 恰好增加一');
        assert.equal(fixture.getProject().entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 45, '写入新工程');
        // 真实 undo：只还原焦距编辑；新文档区别内容仍在，证明没有撤销“打开工程”
        const undone = fixture.history.undo(fixture.getProject());
        assert.ok(undone);
        assert.equal(undone.entities.find(entity => entity.id === cameraA.id)!.camera!.focal, 20, 'undo 恢复新工程原焦距');
        assert.equal(undone.name, '第二份 · 已打开文档', '新工程区别内容仍在：打开工程未被撤销');
        fixture.ctx.project = undone;
        fixture.ctx.changed(); // 生产 undo 命令语义：changed() → 刷新
        ui.handle.refresh();
        assert.equal(ui.input.value, '20', '撤销后属性栏显示还原后的焦距');
    }
});

test('B-R02：无活动受管会话但 unconfirmed=true，未确认原因仍然可见，不被“不适用”掩盖', () => {
    const fixture = makeEditorFixture();
    const managed = (fixture.ctx as unknown as { managed: Record<string, unknown> }).managed;
    managed.available = true; managed.managedActive = false; managed.unconfirmed = true;
    const ui = mountStatus(fixture.ctx);
    ui.handle.refresh();
    assert.match(ui.row('confirm').textContent, /未确认：此前受管操作未完成补偿，保存会被拒绝/);
    assert.doesNotMatch(ui.row('confirm').textContent, /不适用/, '未确认原因不得被不适用文案掩盖');
    // lease/gate/busy/保存状态仍各自独立显示
    assert.match(ui.row('lease').textContent, /不适用（未使用受管项目）/);
    assert.match(ui.row('managed').textContent, /未使用受管项目/);
    assert.match(ui.row('gate').textContent, /整档禁写：无（可正常写入）/);
    assert.match(ui.row('busy').textContent, /忙碌：否/);
    const saveStatus = byId.get('save-status')!;
    saveStatus.textContent = '受管状态未确认';
    ui.handle.refresh();
    assert.match(ui.row('save').textContent, /保存状态（只读）：受管状态未确认/, '原保存状态独立回显');
    assert.equal(saveStatus.textContent, '受管状态未确认', '模块不改写原状态栏');
});
