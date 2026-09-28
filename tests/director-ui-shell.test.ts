import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountDirectorShell } from '../src/director-ui/shell.ts';
import type { AppContext } from '../src/app-context.ts';
import { demoProject } from '../src/model.ts';

/** 最小 DOM 桩：只覆盖 shell.ts 实际使用的节点操作（含文本替换、精确 insertBefore、
 * classList、keydown 监听与合成按键事件），驱动真实装配/切换/按键逻辑；不做关键词式断言。
 * 测试文件在独立进程中运行，直接替换 document。 */
class StubNode {
    parent: StubNode | null = null;
    children: StubNode[] = [];
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    className = ''; text = '';
    value = ''; disabled = false; // DSK-005-B：属性输入框/禁用提交按钮需要的表单语义
    listeners = new Map<string, Array<(event?: unknown) => void>>();
    _id = '';
    constructor(tag: string) { void tag; }
    get id() { return this._id; }
    set id(value: string) { this._id = value; if (value) byId.set(value, this); }
    set innerHTML(value: string) {
        for (const child of this.children) child.parent = null;
        this.children = [];
        const text = value.replace(/<[^>]*>/g, '');
        if (text) {
            const node = new StubNode('#text');
            node.text = text;
            this.append(node);
        }
    }
    get parentNode() { return this.parent; }
    get parentElement() { return this.parent; }
    get nextSibling(): StubNode | null {
        const parent = this.parent;
        return parent ? parent.children[parent.children.indexOf(this) + 1] ?? null : null;
    }
    get isConnected() {
        let node: StubNode | null = this;
        while (node.parent) node = node.parent;
        return node === docRoot;
    }
    append(...nodes: StubNode[]) { for (const node of nodes) { detach(node); node.parent = this; this.children.push(node); } }
    prepend(node: StubNode) { detach(node); node.parent = this; this.children.unshift(node); }
    insertBefore(node: StubNode, ref: StubNode | null) {
        detach(node); node.parent = this;
        const index = ref ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { for (const child of this.children) child.parent = null; this.children = []; this.text = value; }
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
    /** 合成按键事件：记录 preventDefault/stopPropagation 是否被调用（A-R1 冒泡隔离证据）。
     * repeat=true 模拟长按自动重复（A-R1-R2）。 */
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
    /** 通用事件发射（B：input 事件驱动“未提交输入”标记）。 */
    emit(type: string, event: Record<string, unknown> = {}) {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }
    focus() { doc.activeElement = this; }
    *walk(): Generator<StubNode> { yield this; for (const child of this.children) yield* child.walk(); }
}
function detach(node: StubNode) {
    const parent = node.parent;
    if (parent) parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = null;
}

const docRoot = new StubNode('#document');
const byId = new Map<string, StubNode>();
const bySelector = new Map<string, StubNode>();
const doc = {
    activeElement: null as StubNode | null,
    createElement: (tag: string) => new StubNode(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: (selector: string) => bySelector.get(selector) ?? null,
    body: docRoot,
};
(globalThis as Record<string, unknown>).document = doc;

function buildApp() {
    byId.clear(); bySelector.clear(); doc.activeElement = null;
    const app = new StubNode('div'); app.id = 'app';
    const topbar = new StubNode('header'); topbar.className = 'topbar';
    const header = new StubNode('div'); header.className = 'header-actions';
    const undo = new StubNode('button'); undo.setAttribute('data-act', 'undo');
    const saveStatus = new StubNode('span'); saveStatus.id = 'save-status'; saveStatus.textContent = '本地项目';
    const aspect = new StubNode('select'); aspect.id = 'aspect';
    header.append(undo, saveStatus, aspect); topbar.append(header);
    const workspace = new StubNode('div'); workspace.className = 'workspace';
    const sidebar = new StubNode('aside'); sidebar.className = 'sidebar';
    const center = new StubNode('section'); center.className = 'center';
    workspace.append(sidebar, center);
    app.append(topbar, workspace);
    const duration = new StubNode('input'); duration.id = 'duration'; // 原控件位于 .transport-playback
    app.append(duration);
    const menu = new StubNode('div'); menu.id = 'application-menu-file';
    const library = new StubNode('button'); library.id = 'project-library-open';
    const saveCopy = new StubNode('button');
    menu.append(library, saveCopy);
    docRoot.append(app, menu);
    byId.set('app', app); byId.set('project-library-open', library);
    byId.set('save-status', saveStatus); byId.set('duration', duration); byId.set('aspect', aspect);
    bySelector.set('.header-actions', header); bySelector.set('.workspace', workspace); bySelector.set('.center', center);
    return { app, header, menu, library, saveCopy, saveStatus, duration, aspect };
}

/** A-R2：接通的 AppContext 形状边界。state 不再是游离常量——ctx 的 getter 直接读取它，
 * change/seek/selectEntity 按生产 main.ts 的语义（一次编辑 → revision+1、dirty=true）改写它。
 * 边界声明：生产 main.ts 的 dirty/revision 是模块私有值，经由 AppContext getter 暴露给 UI 模块；
 * 本测试在该边界上驱动真实 shell 路径并断言零写入。生产侧的实际 dirty=false→true、暂停时间与
 * 播放推进由 rework1 浏览器/桌面检查经生产可观测面（save-status 文案、engine.time、文档内容）
 * 证实，未添加任何生产插桩或调试 IPC。
 * DSK-005-B 适配：补齐 B 模块读取的保护状态（busy/draft/pending/禁写/受管）与真实 demoProject，
 * 并计数 applyField/renderCameras/toast——挂载与模式切换必须保持零调用。 */
function makeCtx() {
    const calls = { resize: 0, change: 0, changed: 0, seek: 0, select: 0, applyField: 0, renderCameras: 0, toast: 0 };
    const state = { revision: 0, dirty: false, time: 0, selected: 'actor-a', playing: false, duration: 12,
        busy: false, draft: null as { id: string } | null, writeBlocked: null as string | null };
    const project = demoProject();
    const ctx = {
        engine: { requestResize: () => { calls.resize++; }, dragging: false, exporting: false },
        history: { pending: null },
        managed: { available: false, managedActive: false, unconfirmed: false, leaseOwned: false, projectName: '', projectId: '' },
        project,
        current: () => project.entities.find(entity => entity.id === state.selected),
        change(mutate: () => void) {
            calls.change++;
            state.revision += 1; // 与生产一致：一次真实编辑对应一次 revision 递增
            state.dirty = true;
            mutate();
            return true;
        },
        changed() { calls.changed++; state.revision += 1; state.dirty = true; },
        seek(t: number) { calls.seek++; state.time = t; },
        selectEntity(id: string) { calls.select++; state.selected = id; },
        applyField(key: string, value: string) { calls.applyField++; void key; void value; },
        renderCameras() { calls.renderCameras++; },
        toast() { calls.toast++; },
        refuseWrite() { },
        get writeBlockedReason() { return state.writeBlocked; },
        get busy() { return state.busy; },
        get draft() { return state.draft; },
        get revision() { return state.revision; },
        get dirty() { return state.dirty; },
        get time() { return state.time; },
        get selected() { return state.selected; },
        get playing() { return state.playing; },
    };
    return { ctx: ctx as unknown as AppContext, calls, state, project };
}

function toggleIn(header: StubNode) {
    const toggle = header.children.find(node => node.id === 'director-mode-toggle');
    assert.ok(toggle, '切换按钮应挂在顶栏 header-actions 中');
    return toggle;
}

function idsOf(root: StubNode) {
    return [...root.walk()].filter(node => node.id).map(node => node.id);
}

test('简易为默认模式；重复装配幂等，不重复创建控件或重复绑定', () => {
    const { app, header } = buildApp();
    const { ctx, calls } = makeCtx();
    mountDirectorShell(ctx);
    assert.equal(app.dataset.directorShell, 'simple');
    const toggle = toggleIn(header);
    assert.equal(toggle.textContent, '高级编辑');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(header.children.filter(node => node.id === 'director-mode-toggle').length, 1);
    const headerCount = header.children.length;
    const noteCount = [...app.walk()].filter(node => node.id === 'director-task-note').length;
    mountDirectorShell(ctx); // 第二次挂载必须整体 no-op
    assert.equal(header.children.length, headerCount);
    assert.equal([...app.walk()].filter(node => node.id === 'director-task-note').length, noteCount);
    assert.equal(calls.resize, 1);
    assert.equal(calls.change + calls.changed, 0);
});

test('A-R1：模式按钮上的 Space/Enter 一次激活并隔离全局播放，其余按键与组合键不受影响', () => {
    const { header } = buildApp();
    const { ctx } = makeCtx();
    mountDirectorShell(ctx);
    const toggle = toggleIn(header);
    const space1 = toggle.press(' ');
    assert.ok(space1.prevented >= 1, 'Space 必须 preventDefault（不触发滚动/默认激活）');
    assert.ok(space1.stopped >= 1, 'Space 必须 stopPropagation（不冒泡到全局播放）');
    assert.equal(toggle.textContent, '简易视图', '一次 Space 恰好切换一次');
    const space2 = toggle.press(' ');
    assert.ok(space2.prevented >= 1 && space2.stopped >= 1);
    assert.equal(toggle.textContent, '高级编辑', '第二次 Space 切回');
    toggle.press('Enter');
    assert.equal(toggle.textContent, '简易视图', 'Enter 同样一次激活（当前处于高级模式）');
    // 其他按键：不拦截、不切换
    const arrow = toggle.press('ArrowLeft');
    assert.equal(arrow.prevented, 0);
    assert.equal(arrow.stopped, 0);
    assert.equal(toggle.textContent, '简易视图', '非拦截按键不改变模式');
    // 组合键 Ctrl+Space：不劫持（留给全局/系统行为）
    const combo = toggle.press(' ', { ctrl: true });
    assert.equal(combo.prevented, 0);
    assert.equal(combo.stopped, 0);
    assert.equal(toggle.textContent, '简易视图', '组合键不改变模式');
    toggle.press('Enter');
    assert.equal(toggle.textContent, '高级编辑', '回到简易模式收尾');
    // A-R1-R2：长按自动重复——事件仍被隔离，但模式零切换；下一次独立按压恢复正常切换
    const held1 = toggle.press(' ', { repeat: true });
    assert.ok(held1.prevented >= 1 && held1.stopped >= 1, 'repeat 事件同样必须隔离（不落回全局播放）');
    const held2 = toggle.press(' ', { repeat: true });
    assert.ok(held2.prevented >= 1 && held2.stopped >= 1);
    const held3 = toggle.press('Enter', { repeat: true });
    assert.ok(held3.prevented >= 1 && held3.stopped >= 1, 'repeat Enter 同样隔离');
    assert.equal(toggle.textContent, '高级编辑', '长按重复期间模式零切换（仍为按压前的简易）');
    assert.equal(toggle.press(' ').prevented >= 1, true);
    assert.equal(toggle.textContent, '简易视图', '下一次独立按压恢复正常切换');
    toggle.press('Enter');
    assert.equal(toggle.textContent, '高级编辑', '独立 Enter 恢复正常切换');
    // 本按钮无 keyup 监听：keyup 不产生额外切换由真实键盘矩阵在浏览器/桌面检查覆盖
});

/** DSK-005-A 返工：A-R1-R2 repeat 矩阵——简易/高级起始 × Space/Enter × 暂停/播放 共八组独立
 * fixture，node:test 默认串行执行。每组显式设定起始模式与 ctx.playing；高级起始组的一次准备
 * 切换与首次挂载的 resize 计入基线，不计入被测序列。同一键依次发送 repeat=false/true/true/false，
 * 每个事件之后立即逐项断言：模式恰好切到预期（首次切一次、两次 repeat 零切换、末次独立按压切回）、
 * 该事件自身的 preventDefault 与 stopPropagation 分别精确为 1 次（不合并累计、不做布尔弱化）、
 * calls.resize 事件增量依次为 1/0/0/1、ctx.playing 保持组内起始值、焦点仍在模式按钮、
 * 标签与 aria-pressed 同时与模式一致。 */
type RepeatStep = { repeat: boolean; expectedDelta: number };
const repeatSteps: RepeatStep[] = [
    { repeat: false, expectedDelta: 1 },
    { repeat: true, expectedDelta: 0 },
    { repeat: true, expectedDelta: 0 },
    { repeat: false, expectedDelta: 1 },
];
const repeatFixtures = [
    { startMode: 'simple', key: ' ', playing: false },
    { startMode: 'simple', key: ' ', playing: true },
    { startMode: 'simple', key: 'Enter', playing: false },
    { startMode: 'simple', key: 'Enter', playing: true },
    { startMode: 'advanced', key: ' ', playing: false },
    { startMode: 'advanced', key: ' ', playing: true },
    { startMode: 'advanced', key: 'Enter', playing: false },
    { startMode: 'advanced', key: 'Enter', playing: true },
] as const;
for (const fixture of repeatFixtures) {
    const modeName = fixture.startMode === 'simple' ? '简易' : '高级';
    const keyName = fixture.key === ' ' ? 'Space' : 'Enter';
    const playName = fixture.playing ? '播放中' : '暂停';
    test(`A-R1-R2 矩阵 ${modeName}×${keyName}×${playName}：同一键 repeat=false/true/true/false 逐事件断言`, () => {
        const { header } = buildApp();
        const { ctx, calls, state } = makeCtx();
        state.playing = fixture.playing; // 组内显式起始播放态：shell 全程不得改写
        mountDirectorShell(ctx);
        const toggle = toggleIn(header);
        assert.equal(doc.activeElement, toggle, '挂载后焦点应在模式按钮上');
        if (fixture.startMode === 'advanced') toggleIn(header).click(); // 准备切换：其 resize 与挂载 resize 一起计入基线
        const domMode = () =>
            toggle.textContent === '高级编辑' && toggle.getAttribute('aria-pressed') === 'false' ? 'simple'
                : toggle.textContent === '简易视图' && toggle.getAttribute('aria-pressed') === 'true' ? 'advanced'
                    : null;
        assert.equal(domMode(), fixture.startMode, '被测序列开始前标签与 aria-pressed 必须同时等于起始模式');
        let mode: 'simple' | 'advanced' = fixture.startMode;
        let resizeBefore = calls.resize;
        repeatSteps.forEach((step, index) => {
            const recorded = toggle.press(fixture.key, { repeat: step.repeat });
            const delta = calls.resize - resizeBefore;
            resizeBefore = calls.resize;
            if (!step.repeat) mode = mode === 'simple' ? 'advanced' : 'simple';
            const where = `第 ${index + 1} 个事件（repeat=${step.repeat}）`;
            assert.equal(recorded.prevented, 1, `${where} 自身必须恰好一次 preventDefault`);
            assert.equal(recorded.stopped, 1, `${where} 自身必须恰好一次 stopPropagation`);
            assert.equal(delta, step.expectedDelta, `${where} 的 resize 增量应为 ${step.expectedDelta}（整组依次 1、0、0、1）`);
            assert.equal(domMode(), mode, `${where} 后标签与 aria-pressed 必须同时等于模式 ${mode}（repeat 期间零切换）`);
            assert.equal(ctx.playing, fixture.playing, `${where} 后 ctx.playing 必须保持组内起始值 ${fixture.playing}`);
            assert.equal(doc.activeElement, toggle, `${where} 后焦点必须仍在模式按钮`);
        });
        assert.equal(mode, fixture.startMode, '四次事件后模式应经一次切出与一次独立切回到达起始模式');
    });
}

test('A-R2：接通状态边界——双向切换在 dirty=false/true、非零 revision、选择与暂停时间下均零写入', () => {
    const { header } = buildApp();
    const { ctx, state, calls } = makeCtx();
    mountDirectorShell(ctx);
    const snapshot = () => ({ revision: ctx.revision, dirty: ctx.dirty, time: ctx.time, selected: ctx.selected });
    // 干净工程（dirty=false, revision=0）下双向切换
    const clean = snapshot();
    toggleIn(header).click();
    toggleIn(header).click();
    assert.deepEqual(snapshot(), clean, '干净状态下切换零写入');
    assert.equal(state.dirty, false);
    assert.equal(state.revision, 0);
    // 通过边界做一次真实编辑：dirty=false→true、非零 revision、选择与暂停时间变化
    ctx.change(() => { state.duration = 15; });
    ctx.seek(4.2);
    ctx.selectEntity('camera-b');
    const edited = snapshot();
    assert.deepEqual(edited, { revision: 1, dirty: true, time: 4.2, selected: 'camera-b' });
    assert.notEqual(edited.revision, 0);
    // 脏状态下双向切换：全部保持
    toggleIn(header).click();
    assert.deepEqual(snapshot(), edited, '切到高级不得改写已编辑状态');
    toggleIn(header).click();
    assert.deepEqual(snapshot(), edited, '切回简易不得改写已编辑状态');
    assert.equal(calls.change, 1, '只有测试驱动的这一次编辑');
    assert.equal(calls.changed, 0);
});

test('往返切换后项目库唯一、新节点 ID 唯一', () => {
    const { app, header, menu, library } = buildApp();
    const { ctx } = makeCtx();
    mountDirectorShell(ctx);
    toggleIn(header).click();
    toggleIn(header).click();
    assert.equal(app.dataset.directorShell, 'simple');
    assert.equal(library.parent, header);
    assert.equal(header.children.filter(node => node.id === 'project-library-open').length, 1);
    assert.equal(library.classList.contains('subtle'), true, '顶栏项目库为顶栏按钮样式');
    assert.equal(library.classList.contains('menu-command'), false);
    assert.ok(![...menu.walk()].some(node => node.id === 'project-library-open'), '菜单里不得残留项目库');
    const ids = idsOf(app);
    assert.equal(new Set(ids).size, ids.length, '应用内所有 ID 必须唯一');
    for (const id of ['director-mode-toggle', 'director-rail-shots', 'director-rail-properties', 'director-task-note'])
        assert.equal(ids.filter(value => value === id).length, 1, `${id} 应恰好出现一次`);
});

test('切到高级：项目库精确回到菜单原位，请求 resize 且工程状态零改动', () => {
    const { header, menu, library, saveCopy } = buildApp();
    const { ctx, calls, state } = makeCtx();
    mountDirectorShell(ctx);
    assert.equal(library.parent, header); // 简易模式下项目库在顶栏
    toggleIn(header).click();
    const toggle = toggleIn(header);
    assert.equal(toggle.textContent, '简易视图');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(library.parent, menu, '高级模式下项目库必须放回原菜单');
    assert.equal(menu.children.indexOf(library), 0, '恢复到原始位置');
    assert.equal(library.nextSibling, saveCopy, '原始兄弟节点保持不变');
    assert.equal(library.classList.contains('menu-command'), true, '菜单内保持菜单条目样式');
    assert.equal(library.classList.contains('subtle'), false);
    assert.equal(calls.resize, 2, '每次模式切换都调用既有 resize 入口');
    assert.deepEqual(
        { revision: state.revision, dirty: state.dirty, time: state.time, selected: state.selected },
        { revision: 0, dirty: false, time: 0, selected: 'actor-a' },
    );
    assert.equal(calls.change + calls.changed, 0);
});

test('焦点守卫：焦点落入断连节点时恢复到切换按钮；可见焦点不被抢占', () => {
    const { header, saveCopy } = buildApp();
    const { ctx } = makeCtx();
    mountDirectorShell(ctx);
    const detached = new StubNode('input');
    doc.activeElement = detached;
    toggleIn(header).click();
    assert.equal(doc.activeElement, toggleIn(header), '断连焦点必须恢复，不得遗留隐藏焦点');
    doc.activeElement = saveCopy; // 连接中的节点：切换不得抢占焦点
    toggleIn(header).click();
    assert.equal(doc.activeElement, saveCopy);
});

test('B 分区渲染真实镜头/属性/状态内容，A 占位文案移除且语义保持诚实', () => {
    const { app } = buildApp();
    const { ctx, calls } = makeCtx();
    mountDirectorShell(ctx);
    const text = [...app.walk()].map(node => node.textContent).join('\n');
    // 镜头栏来自 demoProject 真实切镜：3 镜（0–5/5–10/10–15），重复机位 A 各为一镜
    assert.match(text, /第 1 镜 · A · 室内全景/);
    assert.match(text, /第 2 镜 · B · 人物跟拍/);
    assert.match(text, /第 3 镜 · A · 室内全景/);
    assert.match(text, /切点属于下一镜/);
    // 简易属性语义诚实：景别不猜、切镜时长只读、戏段作用域、动作交集与锁定边界
    assert.match(text, /未标注/);
    assert.match(text, /切镜时长（只读）/);
    assert.match(text, /作用于整个当前戏段/);
    assert.match(text, /不代表都在画面内/);
    assert.match(text, /不是工作流审批/);
    // 状态区语义诚实：模拟模式固定文案，草稿提交禁用并写明不写工程、不调用模型
    assert.match(text, /模拟模式 · 未运行工作流/);
    assert.match(text, /不会调用模型/);
    assert.match(text, /提交已停用/);
    assert.match(text, /不写入工程/);
    // A 占位彻底移除，不留“后续任务接入”式假占位
    assert.doesNotMatch(text, /将在后续任务接入/);
    // 挂载即渲染也必须零副作用：不定位、不选中、不写焦距、不刷机位条
    assert.equal(calls.seek + calls.select + calls.applyField + calls.renderCameras, 0);
    assert.equal(calls.change + calls.changed, 0);
});

test('B-R03 接线：busy 开始与结束不经 updateTimeUI 也即时更新状态区，且零工程写入', () => {
    const { app } = buildApp();
    const { ctx, calls, state } = makeCtx();
    const handle = mountDirectorShell(ctx);
    const note = [...app.walk()].find(node => node.id === 'director-task-note')!;
    const row = (name: string) => [...note.walk()].find(node => node.dataset.directorStatus === name)!;
    handle.refreshStatus();
    assert.match(row('busy').textContent, /忙碌：否/);
    // 复刻生产 main.ts busy setter 的接线形态：只翻转保护状态并调用 refreshStatus()，
    // 不经过 updateTimeUI——busy 期间帧循环本就跳过 updateTimeUI（区间空间检查等路径）。
    state.busy = true;
    handle.refreshStatus();
    assert.match(row('busy').textContent, /忙碌：是/, 'busy 开始后状态区必须显示忙碌');
    state.busy = false;
    handle.refreshStatus();
    assert.match(row('busy').textContent, /忙碌：否/, 'busy 结束后状态区必须恢复');
    assert.equal(calls.change + calls.changed + calls.applyField + calls.seek + calls.select, 0, '状态刷新零工程/视图写入');
    assert.equal(state.revision, 0);
    assert.equal(state.dirty, false);
});

test('B-R03：main.ts busy setter 必须接线 refreshStatus（main.ts 依赖浏览器装配无法在 node 导入，做装配级源码钉住）', async () => {
    const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    const setter = source.match(/set busy\(value\) \{[^}]*\}/);
    assert.ok(setter, 'uiContext 的 busy setter 应存在');
    assert.match(setter[0], /refreshStatus\(\)/, 'busy setter 翻转后必须调用 directorUI.refreshStatus()');
    assert.match(setter[0], /busy === value/, '同一值的重复写入不重复刷新');
});
