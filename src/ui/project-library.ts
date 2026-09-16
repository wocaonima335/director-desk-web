// DSK-004: minimal file-menu project library modal (DSK-005 does the full redesign).
// Lists managed projects with nextCursor pagination (R11), creates/opens/closes managed sessions,
// saves snapshots, exports .director copies, runs backup/restore through the main-process native
// dialogs, and queries project.status for lease/integrity plus the uncertain-save reopen loop.
// All storage semantics live in ManagedProjectController; this module only gates on editor busy
// state and renders results.
import type { AppContext } from '../app-context.ts';
import { prepareDocumentModels } from '../scenes/document-models.ts';
import { exportProjectCopy } from './project-save.ts';
import { $, escape } from './common.ts';

interface ProjectRow { projectId: string; name: string; revision: number; current: unknown; updatedAt: string }
interface ProjectStatusShape {
    projectId: string; name: string; revision: number; current: unknown; updatedAt: string;
    integrity: { objects: number; missing: number; corrupt: number; orphans: number };
    lease: { owned: boolean; busy: boolean; generation?: number };
}
const PAGE_SIZE = 50;

export function mountProjectLibrary(ctx: AppContext) {
    const managed = ctx.managed;
    let nextCursor: string | null = null;
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

    const rowHtml = (row: ProjectRow) =>
        `<button type="button" class="menu-command" data-library-open="${row.projectId}" data-name="${escape(row.name)}">` +
        `${escape(row.name)} · 第 ${row.revision} 版${row.current ? '' : ' · 空'}</button>` +
        `<button type="button" class="menu-command" data-library-status="${row.projectId}" data-name="${escape(row.name)}">查询状态</button>`;
    const moreButtonHtml = () => '<button type="button" class="menu-command" data-library-act="more">加载更多（下一页）</button>';

    async function openLibrary() {
        if (!managed.available) { ctx.toast('当前环境没有项目库（浏览器会话不可用）', true); return; }
        if (ctx.busy || ctx.engine.exporting) { ctx.toast('请先完成当前任务，再打开项目库'); return; }
        // R11: fetch the first page and remember nextCursor for real pagination.
        const reply = await window.directorDesktop!.dsk!('storage.v1.project.list', { limit: PAGE_SIZE });
        if (!reply.ok) { ctx.toast(reply.error.details?.[0] || reply.error.message, true); return; }
        const page = reply.data as { projects: ProjectRow[]; nextCursor: string | null };
        nextCursor = page.nextCursor;
        const statusLine = managed.managedActive
            ? `当前受管项目：<b>${escape(managed.projectName ?? '')}</b> · 第 ${managed.revision} 版${managed.leaseOwned ? '' : ' · 写入被其他进程占用'}`
            : '当前为普通（未管理）会话；创建或打开受管项目后，保存将以不可变快照写入项目库。';
        const rowHtmlList = page.projects.length ? page.projects.map(rowHtml).join('')
            : '<p class="panel-help">项目库还没有项目。编辑当前工程后，用“创建受管项目”保存第一个快照。</p>';
        const body = `<div id="project-library">
            <p class="panel-help">${statusLine}</p>
            <div id="project-library-rows" class="native-editor" style="max-height:42vh;overflow:auto">${rowHtmlList}${nextCursor ? moreButtonHtml() : ''}</div>
            <div id="library-status" class="native-editor" style="max-height:24vh;overflow:auto" hidden></div>
            <div class="native-editor">
                <label>从当前工程创建受管项目<input id="library-new-name" maxlength="80" placeholder="${escape(ctx.project.name.slice(0, 80))}"/></label>
                <button type="button" data-library-act="create">创建受管项目并保存首个快照</button>
                ${managed.managedActive ? '<button type="button" data-library-act="save">保存当前快照（Ctrl+S 同效）</button>' : ''}
                ${managed.managedActive ? `<button type="button" data-library-act="backup">备份项目「${escape(managed.projectName ?? '')}」及全部历史快照</button>` : ''}
                ${managed.managedActive ? '<button type="button" data-library-act="leave">离开受管会话（转为普通会话，保留编辑）</button>' : ''}
                ${managed.managedActive ? '<button type="button" data-library-act="status-current">查询当前项目状态（占用/健康/不确定保存）</button>' : ''}
                <button type="button" data-library-act="export">导出 .director 副本（不清除未保存状态）</button>
                <button type="button" data-library-act="restore">从备份恢复为新项目…</button>
                <p class="panel-help">受管项目仅显式保存快照；崩溃时未保存的编辑不承诺自动恢复。备份/恢复使用系统目录选择框，不会把路径暴露给页面。</p>
            </div></div>`;
        ctx.showModal('项目库', body, '<button data-act="close-modal">关闭</button>');
        const root = $('#project-library');
        root.addEventListener('click', event => {
            const openTarget = (event.target as HTMLElement).closest<HTMLElement>('[data-library-open]');
            if (openTarget) { void openProject(openTarget.dataset.libraryOpen!, openTarget.dataset.name ?? ''); return; }
            const statusTarget = (event.target as HTMLElement).closest<HTMLElement>('[data-library-status]');
            if (statusTarget) { void showStatus(statusTarget.dataset.libraryStatus!, statusTarget.dataset.name ?? ''); return; }
            const action = (event.target as HTMLElement).closest<HTMLElement>('[data-library-act]');
            if (!action) return;
            const kind = action.dataset.libraryAct!;
            if (kind === 'create') void createFromCurrent(root);
            else if (kind === 'save') void saveSnapshot();
            else if (kind === 'backup') void backupCurrent();
            else if (kind === 'leave') void leaveManaged();
            else if (kind === 'export') void exportCopy();
            else if (kind === 'restore') void restoreBackup();
            else if (kind === 'more') void loadMore();
            else if (kind === 'status-current' && managed.projectId) void showStatus(managed.projectId, managed.projectName ?? '');
            else if (kind === 'reopen-current') void reopenCurrent();
        });
    }

    /** R11: fetch the next page and append it to the list; failures keep the button for a retry. */
    async function loadMore() {
        if (!nextCursor) return;
        const rowsRoot = $('#project-library-rows');
        const more = rowsRoot?.querySelector<HTMLElement>('[data-library-act="more"]');
        if (more) more.textContent = '正在加载…';
        const reply = await window.directorDesktop!.dsk!('storage.v1.project.list', { limit: PAGE_SIZE, cursor: nextCursor });
        if (!reply.ok) {
            if (more) more.textContent = '加载失败，点击重试';
            ctx.toast(reply.error.details?.[0] || reply.error.message, true);
            return;
        }
        const page = reply.data as { projects: ProjectRow[]; nextCursor: string | null };
        nextCursor = page.nextCursor;
        if (!rowsRoot) return;
        more?.remove();
        rowsRoot.insertAdjacentHTML('beforeend', page.projects.map(rowHtml).join('') + (nextCursor ? moreButtonHtml() : ''));
    }

    /** R11: real project.status query — revision, lease ownership/busy, integrity counters, and
     * the uncertain-save closure: when the library is ahead of the confirmed local revision, the
     * last outcome-unknown commit probably landed and the user can reopen to adopt it. */
    async function showStatus(projectId: string, name: string) {
        const panel = $('#library-status');
        if (!panel) return;
        panel.hidden = false;
        panel.innerHTML = `<p class="panel-help">正在查询「${escape(name)}」的项目状态…</p>`;
        const reply = await window.directorDesktop!.dsk!('project.status', { projectId });
        if (!reply.ok) {
            panel.innerHTML = `<p class="panel-help">状态查询失败：${escape(reply.error.details?.[0] || reply.error.message)}</p>`;
            ctx.toast('项目状态查询失败', true);
            return;
        }
        const status = reply.data as unknown as ProjectStatusShape;
        const uncertainLanded = managed.managedActive && managed.projectId === projectId && status.revision > managed.revision;
        panel.innerHTML = `<div>
            <p><strong>${escape(status.name)}</strong> · 第 ${status.revision} 版 · 更新于 ${escape(status.updatedAt)}</p>
            <p class="panel-help">租约：${status.lease.owned ? '本会话持有写入权' : status.lease.busy ? '被其他进程占用（只读查看）' : '空闲'}${status.lease.generation ? ` · 第 ${status.lease.generation} 代` : ''} · 健康：对象 ${status.integrity.objects}，缺失 ${status.integrity.missing}，损坏 ${status.integrity.corrupt}，孤立 ${status.integrity.orphans}</p>
            ${uncertainLanded ? `<p class="panel-help">库中已有第 ${status.revision} 版，高于本会话确认的第 ${managed.revision} 版：上次不确定的保存可能已实际落盘。如需以库中最新快照为准，请重开当前项目；未保存的修改会被丢弃。</p>
            <button type="button" class="menu-command" data-library-act="reopen-current">重开当前项目（载入库中最新快照）</button>` : ''}
        </div>`;
    }

    /** R11/F09: uncertain-save closure — reload the current managed project from the library's
     * latest snapshot after its status was reviewed. The live session is REUSED (no close, no new
     * lease); dirty edits are confirmed before being dropped. */
    async function reopenCurrent() {
        if (!guard('重开当前项目') || !managed.managedActive || !managed.projectId) return;
        const projectId = managed.projectId, name = managed.projectName ?? '';
        if (ctx.dirty && !await ctx.confirmDiscardEdits('重开当前项目')) {
            ctx.toast('已取消重开；未保存的修改保留');
            return;
        }
        if (ctx.draft || ctx.history.pending || ctx.engine.exporting) {
            ctx.toast('确认期间编辑器状态已变化，请重试');
            return;
        }
        await openProject(projectId, name);
    }

    async function createFromCurrent(root: HTMLElement) {
        if (!guard('创建受管项目')) return;
        const input = root.querySelector<HTMLInputElement>('#library-new-name');
        const name = (input?.value.trim() || ctx.project.name).slice(0, 80);
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        try {
            // R6: settle legacy autosave before the candidate session exists ("create无drain").
            await ctx.drainRecovery();
            const epochBefore = managed.epoch, revisionBefore = ctx.revision;
            // F08: create() stages a candidate — the active binding/lease is untouched by design.
            await managed.create(name);
            const candidateId = managed.candidate?.sessionId ?? null;
            const document = ctx.scenes.document();
            const outcome = await managed.saveSnapshot(document, name);
            if (outcome.status !== 'saved') {
                // The active binding was never touched; release only the candidate session.
                if (candidateId) await managed.closeSessionById(candidateId).catch(() => { });
                if (outcome.status === 'outcome-unknown') ctx.toast('保存结果不确定；候选项目可能已创建，请在项目库中用“查询状态”确认，不要盲目重复创建', true);
                else ctx.toast(`首存失败：${outcome.message}；候选项目已释放，当前编辑与原受管状态均保留`, true);
                return;
            }
            if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) {
                // Stale captured edit state — release the candidate; the snapshot stays in the
                // library but the switch is not committed.
                if (candidateId) await managed.closeSessionById(candidateId).catch(() => { });
                ctx.toast('快照已保存，但期间又有新的修改；候选项目保留在库中（内容不含最新修改）', true);
                return;
            }
            const previous = managed.capture();
            await managed.activate(); // F08 commit point: the persisted choice moves to the candidate
            try {
                // F08: re-verify the captured edit state AFTER the activation receipt.
                if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) {
                    throw Error('激活后工程状态已变化，无法安全提交切换');
                }
            } catch (commitError) {
                // Restore the persisted choice to the previous state; a failed compensation marks
                // the controller explicitly unconfirmed and snapshot writes stay blocked (F08).
                await managed.compensateTo(previous);
                if (candidateId && candidateId !== managed.sessionId) await managed.closeSessionById(candidateId).catch(() => { });
                throw commitError;
            }
            if (previous && previous.sessionId !== managed.sessionId) {
                await managed.closeSessionById(previous.sessionId).catch(error => {
                    ctx.toast(`原会话释放失败（租约将在超时后自动回收）：${(error as Error).message}`, true);
                });
            }
            ctx.dirty = false;
            $('#save-status').textContent = `受管项目：${managed.projectName}`;
            ctx.toast(`已创建受管项目「${name}」并保存首个快照（第 ${outcome.revision} 版）`);
            ctx.closeModal();
        } catch (error) {
            ctx.toast((error as Error).message, true);
        } finally {
            ctx.busy = false; ctx.updateTimeUI();
        }
    }

    async function openProject(projectId: string, name: string) {
        if (!guard('打开项目')) return;
        // F10: unified dirty confirmation for every whole-document switch. Cancelling here has NO
        // candidate/identity/lease side effects because nothing has been staged yet.
        if (ctx.dirty && !await ctx.confirmDiscardEdits('打开其他项目')) {
            ctx.toast('已取消打开；未保存的修改保留');
            return;
        }
        if (ctx.draft || ctx.history.pending || ctx.engine.exporting) {
            ctx.toast('确认期间编辑器状态已变化，请重试');
            return;
        }
        ctx.busy = true; ctx.playing = false; ctx.updateTimeUI();
        const epochBefore = managed.epoch, revisionBefore = ctx.revision;
        let candidateId: string | null = null;
        let committed = false; // the activation receipt moved the persisted choice
        try {
            // F09: a valid active session on the SAME project is reused as-is — no close, no new
            // session, no lease churn. This is also the uncertain-save reopen path.
            const reusable = managed.reuseActiveSession(projectId);
            let sessionKey: string;
            let sessionRevision: number;
            if (reusable) {
                sessionKey = reusable.sessionId;
                sessionRevision = reusable.revision;
            } else {
                const session = await managed.open(projectId);
                candidateId = session.sessionId;
                if (session.leaseBusy) throw Error(`项目「${name}」正被其他进程写入，暂不能打开`);
                if (!session.current) throw Error('该项目还没有保存的快照');
                sessionKey = session.sessionId;
                sessionRevision = session.revision;
            }
            const { document } = await managed.download();
            await prepareDocumentModels(ctx.engine.externalModels, document);
            if (ctx.draft || ctx.history.pending || ctx.engine.exporting) throw Error('打开期间编辑器出现未完成的操作，请重试');
            if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) throw Error('打开期间工程已变化，请重试');
            await ctx.drainRecovery();
            if (reusable) {
                // Same-project reload: session and persisted choice are already correct.
                ctx.applyDocument(document, ctx.scenes.context, '打开项目', true, true); // R5: fresh history
                ctx.dirty = false;
                $('#save-status').textContent = `受管项目：${managed.projectName}`;
                ctx.toast(`已重开受管项目「${name}」（第 ${sessionRevision} 版）；撤销历史已重新开始`);
                ctx.closeModal();
                return;
            }
            const previous = managed.capture();
            await managed.activate(); // F08 commit point: the persisted choice moves to the candidate
            committed = true;
            try {
                // F08: re-verify the captured edit state AFTER the activation receipt, BEFORE the
                // document is applied; a stale state compensates back to the previous choice.
                if (managed.epoch !== epochBefore || ctx.revision !== revisionBefore) {
                    throw Error('激活后工程状态已变化，无法安全应用');
                }
                ctx.applyDocument(document, ctx.scenes.context, '打开项目', true, true); // R5: fresh history
            } catch (applyError) {
                await managed.compensateTo(previous);
                throw applyError;
            }
            if (previous && previous.sessionId !== sessionKey) {
                await managed.closeSessionById(previous.sessionId).catch(error => {
                    ctx.toast(`原会话释放失败（租约将在超时后自动回收）：${(error as Error).message}`, true);
                });
            }
            ctx.dirty = false;
            $('#save-status').textContent = `受管项目：${managed.projectName}`;
            ctx.toast(`已打开受管项目「${name}」（第 ${sessionRevision} 版）；撤销历史已重新开始`);
            ctx.closeModal();
        } catch (error) {
            // Pre-activate failures: release only the staged candidate — the active binding was
            // never touched, so no restore dance is needed.
            if (!committed && candidateId) await managed.closeSessionById(candidateId).catch(() => { });
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
            await ctx.drainRecovery();
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
