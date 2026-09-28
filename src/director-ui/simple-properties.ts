import type { AppContext } from '../app-context.ts';
import { clipLabel, type Project } from '../model.ts';
import { deriveShots, editorBusyReason, formatSeconds, guardActivationKeys, shotIndexAt, type DirectorShot } from './shot-list.ts';

export interface DirectorProperties {
    /** 文档/选择/时间区间变化后重算文本；内部按 revision+选择+区间早退。
     * 从不 focus，也不覆盖未提交的焦距输入。 */
    refresh(): void;
}

export interface DirectorPropertiesHooks {
    /** “定位原控件”按钮请求壳层切到高级编辑（复用既有模式切换，不复制控件）。 */
    requestAdvanced(): void;
}

const FOCAL_MIN = 8, FOCAL_MAX = 300;

/** DSK-005-B：简易属性栏。只呈现真实能力：
 * 当前镜头机位与焦距（走既有 ctx.applyField('camera.focal', value) 变更边界，一次编辑一个撤销点）、
 * 景别固定“未标注”（不从焦距猜测）、切镜时长只读、总时长/画幅说明作用于整个当前戏段并定位原控件、
 * 区间内真实动作交集汇总（不代表都在画面内）、对象锁定注明不是工作流审批。 */
export function mountSimpleProperties(rail: HTMLElement, ctx: AppContext, hooks: DirectorPropertiesHooks): DirectorProperties {
    const summary = document.createElement('div');
    summary.id = 'director-shot-summary';
    const summaryTitle = document.createElement('p');
    summaryTitle.className = 'director-rail-note';
    summaryTitle.textContent = '当前镜头（随播放头所在区间变化）';
    summary.append(summaryTitle);
    const summaryLines = document.createElement('div');
    summary.append(summaryLines);

    // —— 焦距：唯一可写项，走既有变更边界 ——
    const focalLabel = document.createElement('label');
    focalLabel.textContent = '焦距（毫米）';
    const focalInput = document.createElement('input');
    focalInput.id = 'director-focal-input';
    focalInput.setAttribute('type', 'number');
    focalInput.setAttribute('min', String(FOCAL_MIN));
    focalInput.setAttribute('max', String(FOCAL_MAX));
    focalInput.setAttribute('step', '1');
    focalInput.setAttribute('aria-label', '当前镜头焦距（毫米）');
    const focalApply = document.createElement('button');
    focalApply.id = 'director-focal-apply';
    focalApply.type = 'button';
    focalApply.className = 'subtle';
    focalApply.textContent = '应用焦距';
    const focalNote = document.createElement('p');
    focalNote.className = 'director-rail-note';
    focalLabel.append(focalInput);
    rail.append(summary, focalLabel, focalApply, focalNote);

    // —— 戏段范围：总时长/画幅只读说明 + 定位原控件 ——
    const scope = document.createElement('p');
    scope.id = 'director-scope-note';
    scope.className = 'director-rail-note';
    const scopeLocate = document.createElement('button');
    scopeLocate.id = 'director-scope-locate';
    scopeLocate.type = 'button';
    scopeLocate.className = 'subtle';
    scopeLocate.textContent = '定位时长/画幅原控件';
    scopeLocate.setAttribute('aria-label', '切到高级编辑并定位当前戏段总时长与画幅的原控件');
    rail.append(scope, scopeLocate);

    // —— 人物动作交集 ——
    const actionsTitle = document.createElement('p');
    actionsTitle.className = 'director-rail-note';
    actionsTitle.textContent = '本镜区间内的人物动作（与区间有交集，不代表都在画面内）';
    const actions = document.createElement('div');
    actions.id = 'director-action-list';
    actions.className = 'director-rail-note';
    rail.append(actionsTitle, actions);

    // —— 对象锁定 ——
    const lock = document.createElement('p');
    lock.id = 'director-lock-note';
    lock.className = 'director-rail-note';
    rail.append(lock);

    // 未提交输入保护：用户编辑过或正聚焦时，刷新不得改写输入框内容。
    // B-R01：输入开始时记录当时的 ctx.project 对象引用、工程/戏段身份、目标机位与焦距基准；
    // 提交前复查，文档整体替换（如 history.replace 打开另一文档，sessionId/sceneId/机位/焦距
    // 都可能相同）、目标过期（切到另一戏段的同 ID 机位、显示机位变化）或基准焦距已被其他编辑
    // 改变时拒绝提交并提示重新确认，不再只凭“当前选中等于显示机位”放行。
    let focalEdited = false;
    let focalPending: { project: Project; sessionId: string; sceneId: string; cameraId: string; focal: number } | null = null;
    const sceneIdentity = () => {
        const context = ctx.scenes?.context; // SceneWorkspace.context：{ sessionId, sceneId, revision }
        return {
            sessionId: typeof context?.sessionId === 'string' ? context.sessionId : '',
            sceneId: typeof context?.sceneId === 'string' ? context.sceneId : '',
        };
    };
    focalInput.addEventListener('input', () => {
        if (!focalEdited || !focalPending) { // 输入开始（或旧输入已被判过期作废）：记录复查基准
            const camera = currentShot()?.camera ?? null;
            focalPending = { project: ctx.project, ...sceneIdentity(), cameraId: camera?.id ?? '', focal: camera?.camera?.focal ?? NaN };
        }
        focalEdited = true;
    });
    let lastKey = '';
    let lastCameraId = '';

    guardActivationKeys(focalApply, applyFocal);
    focalApply.addEventListener('click', applyFocal);
    guardActivationKeys(scopeLocate, locateScope);
    scopeLocate.addEventListener('click', locateScope);

    function currentShot(): DirectorShot | undefined {
        const shots = deriveShots(ctx.project);
        return shots[shotIndexAt(shots, ctx.time)];
    }

    /** 焦距写入前的完整复查（不只依赖刷新时状态）：占用、禁写、显示机位与
     * 当前选中一致、目标未过期、未锁定；数值合法且确有变化才提交一次。 */
    function applyFocal() {
        const blocked = editorBusyReason(ctx);
        if (blocked) { ctx.toast(`焦距暂不可修改：${blocked}`, true); return; }
        const denied = ctx.writeBlockedReason;
        if (denied) { ctx.toast(denied, true); return; }
        const shot = currentShot();
        const camera = shot?.camera ?? null;
        if (!camera?.camera) { ctx.toast('当前镜头没有可用摄影机，无法修改焦距', true); return; }
        if (ctx.selected !== camera.id) { ctx.toast('请先点击该镜头卡片选中其摄影机，再修改焦距', true); return; }
        const target = ctx.current();
        if (!target || target.id !== camera.id) { ctx.toast('选中对象已变化，请重新选择后再修改焦距', true); return; }
        if (target.locked) { ctx.toast('该摄影机已锁定；请先在高级编辑中解锁（锁定仅防止误编辑）', true); return; }
        // B-R01：未提交输入必须仍属于“输入开始时”的同一工程对象（文档整体替换即过期）、
        // 同一戏段、同一目标机位与焦距基准。
        if (focalEdited) {
            const identity = sceneIdentity();
            const stale = !focalPending
                || focalPending.project !== ctx.project
                || focalPending.sessionId !== identity.sessionId || focalPending.sceneId !== identity.sceneId
                || focalPending.cameraId !== camera.id || focalPending.focal !== camera.camera.focal;
            if (stale) {
                focalPending = null; // 旧输入作废：重新编辑形成新基准前，再次提交继续拒绝
                // 焦点不在输入框时直接恢复显示当前真实焦距；焦点仍在输入框则保留文本但保持作废。
                focalEdited = document.activeElement === focalInput || !Number.isFinite(camera.camera.focal);
                if (!focalEdited) focalInput.value = String(camera.camera.focal);
                ctx.toast('焦距输入已过期：目标或焦距基准已被其他编辑改变，请按当前显示值重新输入并确认', true);
                return;
            }
        }
        const value = Number(focalInput.value);
        if (!Number.isFinite(value) || value < FOCAL_MIN || value > FOCAL_MAX) {
            ctx.toast(`焦距需在 ${FOCAL_MIN} 到 ${FOCAL_MAX} 毫米之间`, true);
            return;
        }
        if (value === camera.camera.focal) { ctx.toast('焦距未变化，无需提交'); return; }
        // 一次完成编辑只产生一个撤销点：只调用一次既有 applyField，不直接改字段。
        ctx.applyField('camera.focal', String(value));
        focalEdited = false;
        focalPending = null; // 本次输入已提交：基准随成功编辑一并作废
        lastKey = ''; // 立即重算显示（生产中 changed()→renderPanels 也会触发）
        refresh();
    }

    /** duration/aspect 作用于整个当前戏段：说明文字 + 定位原控件（复用既有模式切换，
     * 不复制任何控件）。#aspect 在简易模式被壳层隐藏，切到高级后可见再聚焦。 */
    function locateScope() {
        hooks.requestAdvanced();
        const aspect = document.getElementById('aspect');
        const duration = document.getElementById('duration');
        const target = aspect ?? duration;
        if (target) target.focus(); // 用户主动点击的定位动作；refresh 路径从不 focus
    }

    function refresh() {
        const shots = deriveShots(ctx.project);
        const index = shotIndexAt(shots, ctx.time);
        const shot = shots[index];
        const camera = shot?.camera ?? null;
        const key = `${ctx.revision}|${ctx.selected}|${index}|${shots.map(s => s.cameraId).join(',')}|${camera?.camera?.focal ?? ''}|${camera?.locked ?? ''}`;
        if (key === lastKey) return; // 播放逐帧刷新早退，不重算文本、不触碰输入
        lastKey = key;
        if (camera && camera.id !== lastCameraId) {
            lastCameraId = camera.id;
            focalEdited = false; // 换镜头后旧输入不再属于目标，允许覆写
            focalPending = null;
        }

        // 当前镜头摘要
        const length = shot ? Number(shot.end) - Number(shot.start) : NaN;
        const lines: Array<[string, string]> = [
            ['镜头', shot ? `第 ${index + 1} 镜` : '不可用'],
            ['摄影机', camera ? camera.name : '机位不可用'],
            ['景别', '未标注（本版本不推断景别）'],
            ['切镜时长（只读）', Number.isFinite(length) && length > 0 ? `${length.toFixed(1)} 秒` : '不可用'],
        ];
        summaryLines.textContent = '';
        for (const [name, value] of lines) {
            const row = document.createElement('div');
            row.textContent = `${name}：${value}`;
            summaryLines.append(row);
        }

        // 焦距输入与共用提示
        const focal = camera?.camera?.focal;
        if (Number.isFinite(focal) && !(focalEdited || document.activeElement === focalInput))
            focalInput.value = String(focal); // 只在无未提交输入时同步；刷新从不抢焦点
        const uses = camera ? shots.filter(s => s.cameraId === camera.id).length : 0;
        focalNote.textContent = !Number.isFinite(focal) ? '当前镜头没有可用焦距。'
            : uses > 1 ? `该摄影机被 ${uses} 个镜头共用：焦距修改对共用镜头共同生效，可用 Ctrl+Z 撤销。`
                : '修改走既有变更边界，一次编辑一个撤销点，可 Ctrl+Z 撤销。';

        // 戏段范围说明（原控件在顶栏/播放条，不在此复制）
        scope.textContent = `当前戏段总时长 ${formatSeconds(ctx.project?.duration)} · 画幅 ${ctx.project?.aspect ?? '不可用'} —— 作用于整个当前戏段，不是单个镜头；调整请使用原控件（高级编辑）。`;

        // 区间内有正长度交集的真实动作片段
        actions.textContent = '';
        const start = shot?.start ?? 0, end = shot?.end ?? 0;
        const rows: string[] = [];
        if (shot && Number.isFinite(end)) {
            for (const entity of ctx.project?.entities ?? []) {
                for (const clip of entity.clips ?? []) {
                    if (clip && clip.end > clip.start && clip.end > start && clip.start < end)
                        rows.push(`${entity.name}：${clipLabel(clip)}（${clip.start.toFixed(1)}–${clip.end.toFixed(1)} 秒）`);
                }
            }
        }
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.textContent = '本镜区间内没有动作片段。';
            actions.append(empty);
        } else {
            for (const row of rows) {
                const item = document.createElement('div');
                item.textContent = row;
                actions.append(item);
            }
        }

        // 对象锁定：展示显示机位的真实锁定状态
        lock.textContent = camera
            ? `对象锁定：${camera.locked ? `“${camera.name}”已锁定` : '当前镜头摄影机未锁定'}。锁定仅防止误编辑，不是工作流审批。`
            : '对象锁定：机位不可用。锁定仅防止误编辑，不是工作流审批。';
    }

    refresh();
    return { refresh };
}
