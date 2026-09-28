import type { AppContext } from '../app-context.ts';
import { guardActivationKeys } from './shot-list.ts';

export interface DirectorTaskStatus {
    /** 保护状态/保存状态变化后重读并更新状态行；只读观察 #save-status，
     * 不覆盖它、不推断保存结果、不触碰草稿输入、从不 focus。 */
    refresh(): void;
}

/** DSK-005-B：任务状态区。固定“模拟模式 · 未运行工作流”；自然语言草稿只留在本页，
 * 提交禁用且写明原因——不写工程、不调用模型、不调用旧助手。
 * writeBlockedReason、managed.unconfirmed、受管写入许可、busy/draft/pending 各自独立显示，
 * 不互相冒充；#save-status 只读回显，保存成功/失败语义完全交给原状态栏。 */
export function mountTaskStatus(note: HTMLElement, ctx: AppContext): DirectorTaskStatus {
    const title = document.createElement('b');
    title.textContent = '模拟模式 · 未运行工作流';
    const intro = document.createElement('span');
    intro.textContent = 'DSK 工作流尚未接入：不会调用模型，也不修改工程。可播放预演，或使用“高级编辑”完整制作。';
    note.append(title, intro);

    // —— 自然语言草稿：仅本页文本，提交禁用并关联原因 ——
    const draftLabel = document.createElement('label');
    draftLabel.textContent = '自然语言草稿（仅保存在本页）';
    const draftInput = document.createElement('textarea');
    draftInput.id = 'director-draft-input';
    draftInput.setAttribute('aria-label', '自然语言工作流草稿（未接入，仅保存在本页）');
    draftInput.setAttribute('rows', '2');
    const draftSend = document.createElement('button');
    draftSend.id = 'director-draft-send';
    draftSend.type = 'button';
    draftSend.className = 'subtle';
    draftSend.textContent = '发送草稿';
    draftSend.disabled = true; // 提交禁用：无工作流可接收；真实 DOM 中禁用按钮也不产生点击
    draftSend.setAttribute('aria-disabled', 'true');
    const draftReason = document.createElement('span');
    draftReason.textContent = '提交已停用：工作流未接入，草稿不写入工程、不调用模型。';
    draftLabel.append(draftInput);
    // 键盘隔离照常挂载：即使未来启用，Space/Enter 也先隔离再拒绝 repeat，不触发全局播放。
    guardActivationKeys(draftSend, () => { /* 无工作流：保持零动作 */ });
    note.append(draftLabel, draftSend, draftReason);

    // —— 独立状态行 ——
    const statusLines = document.createElement('div');
    statusLines.id = 'director-status-lines';
    const fields = ['gate', 'managed', 'confirm', 'lease', 'busy', 'drawing', 'pending', 'save'] as const;
    const nodes = new Map<string, HTMLElement>(fields.map(name => {
        const row = document.createElement('div');
        row.dataset.directorStatus = name;
        statusLines.append(row);
        return [name, row] as const;
    }));
    note.append(statusLines);

    let lastSignature = '';

    const managedSummary = () => {
        const managed = ctx.managed;
        if (!managed.available) return '项目库未启用（本地会话）';
        if (!managed.managedActive) return '未使用受管项目';
        return `受管项目：${managed.projectName ?? managed.projectId ?? '未知名称'}`;
    };
    const confirmSummary = () => {
        const managed = ctx.managed;
        // B-R02：控制器允许 unconfirmed 在没有活动会话时仍为 true，保存入口也会拒绝；
        // 只要 unconfirmed 为 true 就必须显示未确认原因，不得被“无活动会话/未使用受管项目”掩盖。
        if (managed.unconfirmed)
            return '未确认：此前受管操作未完成补偿，保存会被拒绝；请在项目库重新打开项目';
        if (!managed.available || !managed.managedActive) return '不适用（未使用受管项目）';
        return '无未确认状态';
    };
    const leaseSummary = () => {
        const managed = ctx.managed;
        if (!managed.available || !managed.managedActive) return '不适用（未使用受管项目）';
        return managed.leaseOwned ? '本会话持有写入许可' : '未持有写入许可';
    };

    function refresh() {
        const saveStatus = document.getElementById('save-status');
        const signature = [
            ctx.writeBlockedReason ?? '', managedSummary(), confirmSummary(), leaseSummary(),
            String(!!ctx.busy), String(!!ctx.draft), String(!!ctx.history.pending),
            saveStatus?.textContent ?? '',
        ].join('|');
        if (signature === lastSignature) return;
        lastSignature = signature;
        const values: Record<(typeof fields)[number], string> = {
            gate: `整档禁写：${ctx.writeBlockedReason ?? '无（可正常写入）'}`,
            managed: `项目库：${managedSummary()}`,
            confirm: `受管确认：${confirmSummary()}`,
            lease: `受管写入许可：${leaseSummary()}`,
            busy: `忙碌：${ctx.busy ? '是' : '否'}`,
            drawing: `路径绘制：${ctx.draft ? '进行中' : '无'}`,
            pending: `待提交编辑事务：${ctx.history.pending ? '有' : '无'}`,
            save: `保存状态（只读）：${saveStatus?.textContent ?? '（未找到保存状态栏）'}`,
        };
        for (const [name, row] of nodes) {
            const text = values[name as keyof typeof values];
            if (row.textContent !== text) row.textContent = text; // 只写自己的行，不触碰 #save-status
        }
    }

    // 生产环境只读观察原保存状态栏（保存结果/未知/失败由原逻辑写入，这里仅回显）。
    const saveStatus = document.getElementById('save-status');
    if (saveStatus && typeof MutationObserver !== 'undefined')
        new MutationObserver(() => refresh()).observe(saveStatus, { childList: true, characterData: true, subtree: true });

    refresh();
    return { refresh };
}
