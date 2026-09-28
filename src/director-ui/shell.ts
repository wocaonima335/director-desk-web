import type { AppContext } from '../app-context.ts';
import { mountShotList } from './shot-list.ts';
import { mountSimpleProperties } from './simple-properties.ts';
import { mountTaskStatus } from './task-status.ts';
type ShellMode = 'simple' | 'advanced';
const toggleLabels: Record<ShellMode, string> = { simple: '高级编辑', advanced: '简易视图' };

/** B 模块刷新句柄：main.ts 在文档/选择（renderPanels）、时间（updateTimeUI）、
 * 保护状态（busy 变化处）调用，模块自身保证幂等与只读。 */
export interface DirectorUiRefresh {
    /** 文档/选择/戏段变化：镜头重派生、属性重算、状态重读。 */
    refreshPanels(): void;
    /** 时间推进：只更新当前镜头标记与时间相关文本，不重建列表。 */
    refreshTime(): void;
    /** 保护状态变化：只刷新状态区。 */
    refreshStatus(): void;
}

const noopRefresh: DirectorUiRefresh = { refreshPanels() { }, refreshTime() { }, refreshStatus() { } };

/** DSK-005-A 任务式壳层：在既有装配（含 mountApplicationMenu 的控件移动）之后挂载。
 * 只移动既有节点、新增独立标记节点，不复制控件、不重绑业务监听、不触碰引擎实例；
 * 模式切换仅改变壳层视图（data-director-shell + CSS），工程内容、revision、dirty、
 * 时间与选中完全不变，并调用既有 engine.requestResize() 入口。
 * DSK-005-B：三个占位分区换成真实模块（镜头列表 / 简易属性 / 任务状态），
 * 挂载语义与幂等守卫保持不变。 */
export function mountDirectorShell(ctx: AppContext): DirectorUiRefresh {
    if (document.getElementById('director-mode-toggle')) return noopRefresh; // 装配幂等：不重复挂载、不重复绑定
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
    const shotTitle = document.createElement('h2');
    shotTitle.textContent = '镜头';
    shotRail.append(shotTitle);
    const shots = mountShotList(shotRail, ctx);

    const propertyRail = document.createElement('aside');
    propertyRail.id = 'director-rail-properties';
    propertyRail.className = 'director-rail director-simple-only';
    propertyRail.setAttribute('aria-label', '简易属性');
    const propertyTitle = document.createElement('h2');
    propertyTitle.textContent = '属性';
    propertyRail.append(propertyTitle);
    // requestAdvanced 复用既有 setMode：属性栏“定位原控件”先回高级编辑再聚焦原控件。
    const properties = mountSimpleProperties(propertyRail, ctx, { requestAdvanced: () => setMode('advanced') });
    workspace.append(shotRail, propertyRail);

    const note = document.createElement('div');
    note.id = 'director-task-note';
    note.className = 'director-simple-only';
    note.setAttribute('role', 'note');
    const status = mountTaskStatus(note, ctx);
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

    return {
        refreshPanels() { shots.refresh(); properties.refresh(); status.refresh(); },
        refreshTime() { shots.refreshMarker(); properties.refresh(); status.refresh(); },
        refreshStatus() { status.refresh(); },
    };
}
