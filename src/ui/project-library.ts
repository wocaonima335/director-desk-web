// DSK-004: minimal file-menu project library modal (DSK-005 does the full redesign).
// Lists managed projects, creates/opens/closes managed sessions, saves snapshots, exports .director
// copies, runs backup/restore through the main-process native dialogs. All storage semantics live
// in ManagedProjectController; this module only gates on editor busy state and renders results.
import type { AppContext } from '../app-context.ts';
import { prepareDocumentModels } from '../scenes/document-models.ts';
import { exportProjectCopy } from './project-save.ts';
import { $, escape } from './common.ts';

interface ProjectRow { projectId: string; name: string; revision: number; current: unknown; updatedAt: string }

export function mountProjectLibrary(ctx: AppContext) {
    const managed = ctx.managed;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'project-library-open';
    button.className = 'subtle';
    button.setAttribute('data-menu-entry', 'project-library');
    button.textContent = '项目库';
    button.addEventListener('click', () => { void openLibrary(); });
    document.body.append(button);

    function guard(label: string): boolean {
        if (!managed.available) { ctx.toast('当前环境没有项目库（浏览器会话不可用）', true); return false; }
        if (ctx.busy || ctx.engine.exporting || ctx.history.pending || ctx.draft) {
            ctx.toast('请先完成当前编辑、导出或绘制操作，再' + label);
            return false;
        }
        return true;
    }

    async function openLibrary() {
        if (!managed.available) { ctx.toast('当前环境没有项目库（浏览器会话不可用）', true); return; }
        if (ctx.busy || ctx.engine.exporting) { ctx.toast('请先完成当前任务，再打开项目库'); return; }
        const reply = await window.directorDesktop!.dsk!('storage.v1.project.list', { limit: 50 });
        if (!reply.ok) { ctx.toast(reply.error.details?.[0] || reply.error.message, true); return; }
        const rows: ProjectRow[] = (reply.data as { projects: ProjectRow[] }).projects;
        const statusLine = managed.managedActive
            ? `当前受管项目：<b>${escape(managed.projectName ?? '')}</b> · 第 ${managed.revision} 版${managed.leaseOwned ? '' : ' · 写入被其他进程占用'}`
            : '当前为普通（未管理）会话；创建或打开受管项目后，保存将以不可变快照写入项目库。';
        const rowHtml = rows.length ? rows.map(row =>
            `<button type="button" class="menu-command" data-library-open="${row.projectId}" data-name="${escape(row.name)}">` +
            `${escape(row.name)} · 第 ${row.revision} 版${row.current ? '' : ' · 空'}</button>`).join('')
            : '<p class="panel-help">项目库还没有项目。编辑当前工程后，用“创建受管项目”保存第一个快照。</p>';
        const body = `<div id="project-library">
            <p class="panel-help">${statusLine}</p>
            <div id="project-library-rows" class="native-editor">${rowHtml}</div>
            <div class="native-editor">
                <label>从当前工程创建受管项目<input id="library-new-name" maxlength="80" placeholder="${escape(ctx.project.name.slice(0, 80))}"/></label>
                <button type="button" data-library-act="create">创建受管项目并保存首个快照</button>
                ${managed.managedActive ? '<button type="button" data-library-act="save">保存当前快照（Ctrl+S 同效）</button>' : ''}
                ${managed.managedActive ? `<button type="button" data-library-act="backup">备份项目「${escape(managed.projectName ?? '')}」及全部历史快照</button>` : ''}
                ${managed.managedActive ? '<button type="button" data-library-act="leave">离开受管会话（转为普通会话，保留编辑）</button>' : ''}
                <button type="button" data-library-act="export">导出 .director 副本（不清除未保存状态）</button>
                <button type="button" data-library-act="restore">从备份恢复为新项目…</button>
                <p class="panel-help">受管项目仅显式保存快照；崩溃时未保存的编辑不承诺自动恢复。备份/恢复使用系统目录选择框，不会把路径暴露给页面。</p>
            </div></div>`;
        ctx.showModal('项目库', body, '<button data-act="close-modal">关闭</button>');
        const root = $('#project-library');
        root.addEventListener('click', event => {
            const openTarget = (event.target as HTMLElement).closest<HTMLElement>('[data-library-open]');
            if (openTarget) { void openProject(openTarget.dataset.libraryOpen!, openTarget.dataset.name ?? ''); return; }
            const action = (event.target as HTMLElement).closest<HTMLElement>('[data-library-act]');
            if (!action) return;
            const kind = action.dataset.libraryAct!;
            if (kind === 'create') void createFromCurrent(root);
            else if (kind === 'save') void saveSnapshot();
            else if (kind === 'backup') void backupCurrent();
            else if (kind === 'leave') void leaveManaged();
            else if (kind === 'export') void exportCopy();
            else if (kind === 'restore') void restoreBackup();
        });
    }

    async function createFromCurrent(root: HTMLElement) {
        if (!guard('创建受管项目')) return;
        const input = root.querySelector<HTMLInputElement>('#library-new-name');
        const name = (input?.value.trim() || ctx.project.name).slice(0, 80);
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        try {
            const epochBefore = managed.epoch, revisionBefore = ctx.revision;
            await managed.create(name);
            const document = ctx.scenes.document();
            const outcome = await managed.saveSnapshot(document, name);
            if (outcome.status !== 'saved') {
                await managed.closeSession().catch(() => { });
                if (outcome.status === 'outcome-unknown') ctx.toast('保存结果不确定；项目可能已创建，请先查询项目状态，不要盲目重复创建', true);
                else ctx.toast(`首存失败：${outcome.message}；新项目在库中保持为空，当前编辑内容与未保存状态均保留`, true);
                return;
            }
            if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) {
                ctx.toast('快照已保存，但期间又有新的修改；请再次保存以保留最新内容', true);
            } else {
                await managed.activate();
                ctx.dirty = false;
                $('#save-status').textContent = `受管项目：${managed.projectName}`;
                ctx.toast(`已创建受管项目「${name}」并保存首个快照（第 ${outcome.revision} 版）`);
                ctx.closeModal();
            }
        } catch (error) {
            await managed.closeSession().catch(() => { });
            ctx.toast((error as Error).message, true);
        } finally {
            ctx.busy = false; ctx.updateTimeUI();
        }
    }

    async function openProject(projectId: string, name: string) {
        if (!guard('打开项目')) return;
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        const previous = managed.capture();
        let targetOpened = false;
        try {
            const epochBefore = managed.epoch, revisionBefore = ctx.revision;
            const session = await managed.open(projectId);
            targetOpened = true;
            if (session.leaseBusy) throw Error(`项目「${name}」正被其他进程写入，暂不能打开`);
            if (!session.current) throw Error('该项目还没有保存的快照');
            const { document } = await managed.download();
            await prepareDocumentModels(ctx.engine.externalModels, document);
            if (ctx.draft || ctx.history.pending || ctx.engine.exporting) throw Error('打开期间编辑器出现未完成的操作，请重试');
            if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) throw Error('打开期间工程已变化，请重试');
            await ctx.drainRecovery();
            ctx.applyDocument(document, ctx.scenes.context, '打开项目', true); // bumps managed.epoch
            // Document switched successfully; only now release the old session and confirm identity.
            try {
                if (previous && previous.sessionId !== session.sessionId) await managed.closeSessionById(previous.sessionId);
                await managed.activate();
                ctx.dirty = false;
                $('#save-status').textContent = `受管项目：${managed.projectName}`;
                ctx.toast(`已打开受管项目「${name}」（第 ${session.revision} 版）；撤销历史已重新开始`);
                ctx.closeModal();
            } catch (confirmError) {
                // Document stays loaded; identity stays unconfirmed rather than lying about managed state.
                managed.resetSession();
                $('#save-status').textContent = '受管状态未确认（普通会话）';
                ctx.toast(`项目已打开，但受管状态确认失败：${(confirmError as Error).message}`, true);
            }
        } catch (error) {
            // Failure keeps the original document and session; the target lease is released.
            if (targetOpened) await managed.closeSessionById(managed.sessionId!).catch(() => { });
            if (previous) managed.restoreBinding(previous);
            ctx.toast((error as Error).message, true);
        } finally {
            ctx.busy = false;
            ctx.engine.externalModels.retain([ctx.project, ...ctx.history.undoStack, ...ctx.history.redoStack]);
            ctx.updateTimeUI();
        }
    }

    async function saveSnapshot() {
        ctx.closeModal();
        await ctx.saveProject();
    }

    async function backupCurrent() {
        if (!guard('备份项目') || !managed.projectId) return;
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        try {
            const reply = await window.directorDesktop!.dsk!('storage.v1.backup.create', { projectId: managed.projectId });
            if (!reply.ok) throw Error(reply.error.details?.[0] || reply.error.message);
            const data = reply.data as { cancelled?: boolean; name?: string; snapshots?: number };
            if (data.cancelled) ctx.toast('已取消备份');
            else ctx.toast(`已备份「${data.name}」：${data.snapshots} 个快照（含全部历史版本对象）`);
        } catch (error) {
            ctx.toast((error as Error).message, true);
        } finally { ctx.busy = false; ctx.updateTimeUI(); }
    }

    async function restoreBackup() {
        if (!guard('恢复备份')) return;
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        try {
            const reply = await window.directorDesktop!.dsk!('storage.v1.backup.restore', {});
            if (!reply.ok) throw Error(reply.error.details?.[0] || reply.error.message);
            const data = reply.data as { projectId: string; name: string; snapshots: number };
            ctx.toast(`已从备份恢复为新项目「${data.name}」（${data.snapshots} 个快照）；在列表中选择它即可打开，当前工程未改变`);
            ctx.closeModal();
            void openLibrary();
        } catch (error) {
            ctx.toast((error as Error).message, true);
        } finally { ctx.busy = false; ctx.updateTimeUI(); }
    }

    async function leaveManaged() {
        if (!guard('离开受管会话')) return;
        try {
            await managed.leave();
            $('#save-status').textContent = '普通会话（未管理）';
            ctx.toast('已离开受管会话；当前编辑保留，保存恢复为 .director 文件方式');
            ctx.closeModal();
        } catch (error) {
            ctx.toast((error as Error).message, true);
        }
    }

    async function exportCopy() {
        ctx.closeModal();
        await exportProjectCopy(ctx);
    }
}
