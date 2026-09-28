import type { AppContext } from '../app-context.ts';
import type { Entity, Project } from '../model.ts';

/** DSK-005-B：镜头列表只从当前 Project.cuts 真实派生。
 * 每个切镜到下一个切镜为一个区间，最后一镜到当前戏段总时长；
 * 重复机位不合并（cuts 里两条记录就是两张卡）；不写工程、不伪造 shotId，
 * 卡片身份是 cuts 数组下标 + cameraId + 起止时间。 */
export interface DirectorShot {
    index: number;
    cameraId: string;
    camera: Entity | null;
    start: number;
    end: number;
}

/** 派生本身是纯函数：异常数据（缺切镜、缺失机位、时间异常）不会抛出，
 * 由展示层显示“不可用”。 */
export function deriveShots(project: Project): DirectorShot[] {
    const duration = project && Number.isFinite(project.duration) && project.duration > 0 ? project.duration : NaN;
    const cameras = new Map((project?.entities ?? []).filter(e => e?.kind === 'camera').map(e => [e.id, e] as const));
    const cuts = [...(project?.cuts ?? [])].filter(cut => cut && Number.isFinite(cut.time)).sort((a, b) => a.time - b.time);
    if (!cuts.length)
        return [{ index: 0, cameraId: '', camera: null, start: 0, end: duration }];
    return cuts.map((cut, index) => ({
        index,
        cameraId: typeof cut.cameraId === 'string' ? cut.cameraId : '',
        camera: cameras.get(cut.cameraId) ?? null,
        start: cut.time,
        end: index + 1 < cuts.length ? cuts[index + 1].time : duration,
    }));
}

/** 当前时间落在哪个镜头：区间为 [start, end)，切点归下一卡；
 * time === duration 时标记末卡（末卡右端按含端点处理）。 */
export function shotIndexAt(shots: DirectorShot[], time: number): number {
    if (!shots.length) return -1;
    if (!Number.isFinite(time)) return 0;
    for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];
        const end = i + 1 < shots.length ? shot.end : Number.POSITIVE_INFINITY;
        if (time >= shot.start && time < end) return i;
    }
    return time < shots[0].start ? 0 : shots.length - 1;
}

const numberOrNaN = (value: number) => (Number.isFinite(value) ? value : NaN);
export const formatSeconds = (value: number) => (Number.isFinite(value) ? `${numberOrNaN(value).toFixed(1)} 秒` : '不可用');

/** 卡片/应用焦距等新动作共用的占用检查：busy、绘制中草稿、未完成事务、
 * 引擎拖动、导出中都拒绝视图性切换，尤其避免 draft 时 selectEntity 触发 finishPath。 */
export function editorBusyReason(ctx: Pick<AppContext, 'busy' | 'draft' | 'history' | 'engine'>): string | null {
    if (ctx.busy) return '正在执行其他操作';
    if (ctx.draft) return '正在绘制路径';
    if (ctx.history.pending) return '有未完成的编辑事务';
    if (ctx.engine.dragging) return '正在拖动对象';
    if (ctx.engine.exporting) return '正在导出';
    return null;
}

/** DSK-005-A-R1 同款按键隔离，供 B 新增按钮与镜头卡片复用：
 * Space/Enter（无修饰键）先 preventDefault + stopPropagation 隔离全局行为
 * （events.ts 会把落空的 Space 截为播放），识别为激活键之后再拒绝 event.repeat，
 * 长按自动重复不会连续触发，也不会落回全局播放。 */
export function guardActivationKeys(target: HTMLElement, activate: () => void) {
    target.addEventListener('keydown', event => {
        const key = event as KeyboardEvent;
        if (key.ctrlKey || key.metaKey || key.altKey) return;
        if (key.key !== ' ' && key.key !== 'Enter' && key.code !== 'Space') return;
        key.preventDefault();
        key.stopPropagation();
        if (key.repeat) return; // 先隔离再拒绝：重复事件不激活，也不落回全局播放
        activate();
    });
}

export interface DirectorShotList {
    /** 文档/选择/戏段变化后整体重派生；内容未变化时不重建 DOM。从不调用 focus。 */
    refresh(): void;
    /** 时间推进只更新当前标记，不重建列表（播放期间逐帧调用）。 */
    refreshMarker(): void;
}

/** 挂载到壳层左侧镜头栏（rail 由 shell.ts 创建并保留 h2 标题）。 */
export function mountShotList(rail: HTMLElement, ctx: AppContext): DirectorShotList {
    const note = document.createElement('p');
    note.className = 'director-rail-note';
    note.textContent = '镜头由当前戏段的真实切镜派生；同一机位的多次切镜各为一镜，切点属于下一镜。';
    const list = document.createElement('div');
    list.id = 'director-shot-list';
    rail.append(note, list);

    let cards: HTMLElement[] = [];
    let markedIndex = -1;
    let lastSignature = '';

    const shotTitle = (shot: DirectorShot) => {
        const name = shot.camera ? shot.camera.name : '机位不可用';
        const length = numberOrNaN(shot.end) - numberOrNaN(shot.start);
        const span = `第 ${shot.index + 1} 镜 · ${name}`;
        const detail = Number.isFinite(length) && length > 0
            ? `${formatSeconds(shot.start)} – ${formatSeconds(shot.end)} · 时长 ${length.toFixed(1)} 秒`
            : `${formatSeconds(shot.start)} – ${formatSeconds(shot.end)} · 时长不可用`;
        return `${span} · ${detail}`;
    };

    function renderCards() {
        const shots = deriveShots(ctx.project);
        const signature = JSON.stringify(shots.map(shot => [shot.index, shot.cameraId, shot.camera?.name ?? null, shot.start, shot.end]));
        if (signature === lastSignature) return; // 播放/刷新不重建列表
        lastSignature = signature;
        list.textContent = '';
        cards = shots.map(shot => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'subtle director-shot-card';
            card.setAttribute('data-director-shot', String(shot.index));
            card.setAttribute('aria-label', shotTitle(shot));
            card.textContent = shotTitle(shot);
            const open = () => openShot(shot);
            card.addEventListener('click', open);
            guardActivationKeys(card, open); // 卡片上的 Space/Enter 同样先隔离再激活，repeat 拒绝
            list.append(card);
            return card;
        });
        markedIndex = -1;
        refreshMarker();
    }

    /** 普通点击只改视图状态：停播放、成片预览、seek 区间起点、选中摄影机。
     * 不调用 change/changed，不触碰 dirty/revision/历史；selectEntity 只做选择与面板刷新。 */
    function openShot(shot: DirectorShot) {
        const blocked = editorBusyReason(ctx);
        if (blocked) { ctx.toast(`镜头暂不可切换：${blocked}`, true); return; }
        if (!shot.camera) { ctx.toast('该切镜的摄影机数据不可用，无法定位', true); return; }
        ctx.playing = false;
        ctx.preview = 'program';
        ctx.renderCameras(); // 既有视图刷新入口：同步 engine.previewId 与机位条，无工程写入
        ctx.seek(shot.start);
        ctx.selectEntity(shot.camera.id);
        refreshMarker();
    }

    function refreshMarker() {
        const index = shotIndexAt(deriveShots(ctx.project), ctx.time);
        if (index === markedIndex) return;
        if (markedIndex >= 0 && cards[markedIndex]) {
            cards[markedIndex].classList.remove('director-shot-current');
            cards[markedIndex].setAttribute('aria-current', 'false');
        }
        markedIndex = index;
        if (index >= 0 && cards[index]) {
            cards[index].classList.add('director-shot-current');
            cards[index].setAttribute('aria-current', 'true');
        }
    }

    renderCards();
    return {
        refresh: renderCards,
        refreshMarker,
    };
}
