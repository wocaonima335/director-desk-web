import type { AppContext } from '../app-context.ts';
type ShellMode = 'simple' | 'advanced';
const toggleLabels: Record<ShellMode, string> = { simple: '高级编辑', advanced: '简易视图' };

/** DSK-005-A 任务式壳层：在既有装配（含 mountApplicationMenu 的控件移动）之后挂载。
 * 只移动既有节点、新增独立标记节点，不复制控件、不重绑业务监听、不触碰引擎实例；
 * 模式切换仅改变壳层视图（data-director-shell + CSS），工程内容、revision、dirty、
 * 时间与选中完全不变，并调用既有 engine.requestResize() 入口。 */
export function mountDirectorShell(ctx: AppContext) {
    if (document.getElementById('director-mode-toggle')) return; // 装配幂等：不重复挂载、不重复绑定
    const app = document.getElementById('app')!;
    const header = document.querySelector('.header-actions')!;
    const workspace = document.querySelector('.workspace')!;
    const center = document.querySelector('.center')!;
    // 项目库按钮由 mountProjectLibrary 创建、被 mountApplicationMenu 移入文件菜单弹出层；
    // 记住原位，简易模式移到顶栏，高级模式精确放回（移动而非复制，ID 保持唯一）。
    const library = document.getElementById('project-library-open');
    const libraryHome = library ? { parent: library.parentElement!, next: library.nextSibling } : null;

    const shotRail = document.createElement('aside');
    shotRail.id = 'director-rail-shots';
    shotRail.className = 'director-rail director-simple-only';
    shotRail.setAttribute('aria-label', '镜头');
    shotRail.innerHTML = '<h2>镜头</h2><p class="director-rail-note">镜头列表将在后续任务接入。当前切镜与时间轴请在“高级编辑”中查看和调整。</p>';
    const propertyRail = document.createElement('aside');
    propertyRail.id = 'director-rail-properties';
    propertyRail.className = 'director-rail director-simple-only';
    propertyRail.setAttribute('aria-label', '简易属性');
    propertyRail.innerHTML = '<h2>属性</h2><p class="director-rail-note">简易属性将在后续任务接入。对象、布景与完整属性编辑请使用“高级编辑”。</p>';
    workspace.append(shotRail, propertyRail);

    const note = document.createElement('div');
    note.id = 'director-task-note';
    note.className = 'director-simple-only';
    note.setAttribute('role', 'note');
    note.innerHTML = '<b>模拟模式 · 未运行工作流</b><span>DSK 工作流尚未接入：不会调用模型，也不修改工程。可在下方播放预演，或使用“高级编辑”进行完整制作。</span>';
    center.append(note);

    const toggle = document.createElement('button');
    toggle.id = 'director-mode-toggle';
    toggle.type = 'button';
    toggle.className = 'subtle';
    toggle.addEventListener('click', () => setMode(mode === 'simple' ? 'advanced' : 'simple'));
    // A-R1：模式按钮上的 Space/Enter 必须只激活模式切换一次。全局 events.ts 的文档级 keydown
    // 会把 Space 截为播放；这里在按钮上拦截并阻止冒泡，一次激活，其他位置的 Space 播放不受影响。
    // A-R1-R2：长按的自动重复（event.repeat）同样先隔离再拒绝执行——若先 return，重复 Space
    // 会落回全局播放；识别为激活键后必须先 preventDefault/stopPropagation。
    toggle.addEventListener('keydown', event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key !== ' ' && event.key !== 'Enter' && event.code !== 'Space') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return; // 长按重复不重复切换；松键与下一次独立按压由真实事件驱动
        setMode(mode === 'simple' ? 'advanced' : 'simple');
    });
    header.append(toggle);

    let mode: ShellMode = 'simple';
    function setMode(next: ShellMode) {
        mode = next;
        app.dataset.directorShell = next;
        toggle.textContent = toggleLabels[next];
        toggle.setAttribute('aria-pressed', String(next === 'advanced'));
        toggle.setAttribute('aria-label', next === 'simple' ? '切换到高级编辑模式' : '返回简易视图');
        if (library && libraryHome) {
            if (next === 'simple') {
                header.prepend(library);
                library.classList.remove('menu-command'); // .menu-command 样式限定在菜单弹层内
                library.classList.add('subtle');
            } else {
                library.classList.remove('subtle');
                library.classList.add('menu-command');
                libraryHome.parent.insertBefore(library, libraryHome.next);
            }
        }
        ctx.engine.requestResize(); // 布局显隐变化统一走既有 resize 入口，不重建 canvas 或引擎
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body || !active.isConnected) toggle.focus(); // 不留隐藏焦点，也不抢输入焦点
    }
    setMode('simple');
}
