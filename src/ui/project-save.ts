import type { AppContext } from '../app-context.ts';
import { download } from '../storage.ts';

/** Shared gesture guard: no saving while dragging, drawing, exporting or another task runs. */
function ensureIdle(ctx: AppContext): boolean {
    if (ctx.busy || ctx.engine.exporting) { ctx.toast('请先完成或取消当前任务，再保存项目'); return false; }
    if (ctx.draft) ctx.finishPath();
    if (ctx.history.pending || ctx.draft) { ctx.toast('请先结束当前编辑，再保存项目'); return false; }
    return true;
}

/** Managed sessions save immutable snapshots only; success clears dirty only when the editor
 * has not moved on (epoch/revision captured before the await). Uncertain commits keep dirty. */
async function saveManagedSnapshot(ctx: AppContext): Promise<boolean> {
    const managed = ctx.managed!;
    if (!ensureIdle(ctx)) return false;
    const document = ctx.scenes.document();
    const epochAtSave = managed.epoch;
    const revisionAtSave = ctx.revision;
    ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
    try {
        const outcome = await managed.saveSnapshot(document);
        if (outcome.status === 'saved') {
            const unchanged = managed.epoch === epochAtSave && ctx.revision === revisionAtSave;
            if (unchanged) {
                ctx.dirty = false;
                documentStatus('项目快照已保存');
                ctx.toast(`快照已保存到项目库（第 ${outcome.revision} 版），包含全部 ${document.scenes.length} 个独立戏段及共享资源`);
            } else {
                documentStatus('编辑器已继续修改，保存状态未更新');
                ctx.toast('保存完成，但期间又有新的修改；请再次保存以保留最新内容');
            }
            return unchanged;
        }
        if (outcome.status === 'outcome-unknown') {
            documentStatus('保存结果不确定，请查询项目状态');
            ctx.toast('保存结果不确定（提交回执丢失）；请通过项目库查看项目状态，不要盲目重复保存', true);
            return false;
        }
        documentStatus('快照保存失败');
        ctx.toast(`快照保存失败：${outcome.message}`, true);
        return false;
    } finally {
        ctx.busy = false; ctx.updateTimeUI();
    }
}

/** Legacy `.director` export. In managed sessions it is only a copy and never clears save-dirty. */
export async function saveProjectFile(ctx: AppContext): Promise<boolean> {
    const managed = ctx.managed;
    if (managed?.available && managed.managedActive) return saveManagedSnapshot(ctx);
    if (!ensureIdle(ctx)) return false;
    const document = ctx.scenes.document(), content = JSON.stringify(document, null, 2);
    const name = document.name.replace(/[<>:"/\\|?*]/g, '_') + '.director';
    ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
    try {
        const files = window.directorDesktop?.files;
        if (files) {
            const result = await files('save-project', { name, content });
            if (!result.ok) throw Error(result.error || '保存失败');
            if (!result.data?.saved) return false;
        } else {
            download(new Blob([content], { type: 'application/json' }), name);
            ctx.toast('已发起工程下载；浏览器无法确认保存结果，请确认文件后继续。');
            return false;
        }
        ctx.dirty = false;
        documentStatus('项目已保存');
        ctx.toast(`项目已保存，包含全部 ${document.scenes.length} 个独立戏段及共享模型资源`);
        return true;
    } catch (error) { ctx.toast((error as Error).message, true); return false; }
    finally { ctx.busy = false; ctx.updateTimeUI(); }
}

/** Managed copy export: same .director flow, but dirty state survives (a copy is not a save). */
export async function exportProjectCopy(ctx: AppContext): Promise<boolean> {
    if (!ensureIdle(ctx)) return false;
    const document = ctx.scenes.document(), content = JSON.stringify(document, null, 2);
    const name = document.name.replace(/[<>:"/\\|?*]/g, '_') + '.director';
    ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
    try {
        const files = window.directorDesktop?.files;
        if (files) {
            const result = await files('save-project', { name, content });
            if (!result.ok) throw Error(result.error || '导出失败');
            if (!result.data?.saved) return false;
            ctx.toast('已导出 .director 副本；受管项目的保存仍以快照为准，当前修改保持未保存状态');
            documentStatus('已导出副本（未清除未保存状态）');
            return true;
        }
        download(new Blob([content], { type: 'application/json' }), name);
        ctx.toast('已发起工程下载；浏览器无法确认导出结果。');
        return false;
    } catch (error) { ctx.toast((error as Error).message, true); return false; }
    finally { ctx.busy = false; ctx.updateTimeUI(); }
}
function documentStatus(text: string) { const status = document.querySelector('#save-status'); if (status) status.textContent = text; }
