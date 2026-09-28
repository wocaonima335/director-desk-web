import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDirectorShell } from '../src/director-ui/shell.ts';
import type { AppContext } from '../src/app-context.ts';

/** 最小 DOM 桩：只覆盖 shell.ts 实际使用的节点操作（含文本替换、精确 insertBefore、
 * classList、keydown 监听与合成按键事件），驱动真实装配/切换/按键逻辑；不做关键词式断言。
 * 测试文件在独立进程中运行，直接替换 document。 */
class StubNode {
    parent: StubNode | null = null;
    children: StubNode[] = [];
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    className = ''; text = '';
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
    header.append(undo); topbar.append(header);
    const workspace = new StubNode('div'); workspace.className = 'workspace';
    const sidebar = new StubNode('aside'); sidebar.className = 'sidebar';
    const center = new StubNode('section'); center.className = 'center';
    workspace.append(sidebar, center);
    app.append(topbar, workspace);
    const menu = new StubNode('div'); menu.id = 'application-menu-file';
    const library = new StubNode('button'); library.id = 'project-library-open';
    const saveCopy = new StubNode('button');
    menu.append(library, saveCopy);
    docRoot.append(app, menu);
    byId.set('app', app); byId.set('project-library-open', library);
    bySelector.set('.header-actions', header); bySelector.set('.workspace', workspace); bySelector.set('.center', center);
    return { app, header, menu, library, saveCopy };
}

/** A-R2：接通的 AppContext 形状边界。state 不再是游离常量——ctx 的 getter 直接读取它，
 * change/seek/selectEntity 按生产 main.ts 的语义（一次编辑 → revision+1、dirty=true）改写它。
 * 边界声明：生产 main.ts 的 dirty/revision 是模块私有值，经由 AppContext getter 暴露给 UI 模块；
 * 本测试在该边界上驱动真实 shell 路径并断言零写入。生产侧的实际 dirty=false→true、暂停时间与
 * 播放推进由 rework1 浏览器/桌面检查经生产可观测面（save-status 文案、engine.time、文档内容）
 * 证实，未添加任何生产插桩或调试 IPC。 */
function makeCtx() {
    const calls = { resize: 0, change: 0, changed: 0, seek: 0, select: 0 };
    const state = { revision: 0, dirty: false, time: 0, selected: 'actor-a', playing: false, duration: 12 };
    const ctx = {
        engine: { requestResize: () => { calls.resize++; } },
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
        get revision() { return state.revision; },
        get dirty() { return state.dirty; },
        get time() { return state.time; },
        get selected() { return state.selected; },
        get playing() { return state.playing; },
    };
    return { ctx: ctx as unknown as AppContext, calls, state };
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

test('预留分区与状态文案语义诚实，不伪装已实现', () => {
    const { app } = buildApp();
    const { ctx } = makeCtx();
    mountDirectorShell(ctx);
    const text = [...app.walk()].map(node => node.textContent).join('\n');
    assert.match(text, /镜头列表将在后续任务接入/);
    assert.match(text, /简易属性将在后续任务接入/);
    assert.match(text, /模拟模式 · 未运行工作流/);
    assert.match(text, /不会调用模型/);
});
