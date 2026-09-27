// DSK-004: renderer-side managed project session controller.
// Owns the managed/unmanaged session identity, the storage.v1 wire flow (open/download/save) and
// the epoch counter that lets async completions detect "the editor moved on". No DOM, no Engine:
// every UI side effect stays in the callers (project-save / project-library / main). Validation of
// downloaded documents reuses the shared readSceneDocument verifier.
import type { SceneDocument } from '../scenes/sequence-project.ts';
import { readSceneDocument } from '../scenes/sequence-project.ts';
import { STORAGE_MAX_PROJECT_BYTES } from '../../shared/contracts/index.ts';
import { CanonicalLimitError, canonicalJson } from '../../shared/storage/canonical.ts';

export type DskErrorShape = { code: string; message: string; details?: string[] };
export type DskReply = { ok: true; data: unknown } | { ok: false; error: DskErrorShape };
export type DskCaller = (action: string, data?: unknown) => Promise<DskReply>;

export interface SnapshotRefShape {
    version: string;
    snapshotId: string;
    projectId: string;
    revision: number;
    digest: string;
    createdAt: string;
}

export interface StorageSessionShape {
    sessionId: string;
    projectId: string;
    name: string;
    revision: number;
    current: SnapshotRefShape | null;
    leaseOwned: boolean;
    leaseBusy: boolean;
}

export interface BootstrapShape {
    mode: 'managed' | 'unmanaged' | null;
    projectId: string | null;
    name: string | null;
}

export type SaveOutcome =
    | { status: 'saved'; snapshot: SnapshotRefShape; revision: number }
    | { status: 'outcome-unknown'; message: string }
    | { status: 'failed'; reason: string; message: string };

/** Live session binding captured before a risky switch; restore rebinds without touching the wire. */
export interface SessionBinding {
    sessionId: string;
    projectId: string;
    projectName: string | null;
    revision: number;
    current: SnapshotRefShape | null;
    leaseOwned: boolean;
}

export class StorageRequestError extends Error {
    reason: string;
    /** RP7-R01: set only when storage.v1.session.activate already returned ok. The server committed
     * setLastSession before that receipt; losing the local candidate afterwards does not undo it. */
    readonly serverCommitted: boolean;
    /** The session id the successful activate receipt named. Compensation may use only this id. */
    readonly committedSessionId: string | null;
    constructor(error: DskErrorShape, committed?: { sessionId: string }) {
        super(error.details?.[0] || error.message || '存储操作失败');
        this.name = 'StorageRequestError';
        this.reason = error.message.startsWith('storage.v1/') ? error.message.slice('storage.v1/'.length) : 'storage-unavailable';
        this.serverCommitted = !!committed;
        this.committedSessionId = committed?.sessionId ?? null;
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(binary);
}

/** RP7: exact binding equality for the switch protocol's staleness checks (capture-vs-live). */
export function sameSessionBinding(a: SessionBinding | null, b: SessionBinding | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.sessionId === b.sessionId && a.projectId === b.projectId && a.projectName === b.projectName
        && a.revision === b.revision && a.current === b.current && a.leaseOwned === b.leaseOwned;
}

export class ManagedProjectController {
    /** none: 未选择；managed: 显式确认的受管会话；unmanaged: 显式离开后的普通会话。 */
    identity: 'none' | 'managed' | 'unmanaged' = 'none';
    // F08: the flat fields below are the COMMITTED (active) binding. Staged switches live in
    // `candidate` until activate() promotes them, so a failed open/create can never disturb the
    // active session, its lease or the document identity.
    sessionId: string | null = null;
    projectId: string | null = null;
    projectName: string | null = null;
    revision = 0;
    current: SnapshotRefShape | null = null;
    leaseOwned = false;
    /** The in-flight switch target staged by open()/create(); null when nothing is in flight. */
    candidate: SessionBinding | null = null;
    /** F08: explicit unconfirmed state — set when a post-activate failure could not be
     * compensated; blocks snapshot writes until the user reopens a project explicitly. */
    unconfirmed = false;
    /** Bumped by the editor whenever the whole document is replaced; async flows compare it. */
    epoch = 0;

    private readonly call: DskCaller | undefined;
    constructor(call: DskCaller | undefined) { this.call = call; }

    get available() { return !!this.call; }
    /** Managed with a live session: explicit saves go to snapshots, legacy recovery stays off. */
    get managedActive() { return this.identity === 'managed' && !!this.sessionId; }

    /** Read the last confirmed session choice. Never loads a project or writes anything. */
    async bootstrap(): Promise<BootstrapShape | null> {
        if (!this.call) return null;
        const result = await this.call('storage.v1.session.bootstrap', {});
        if (!result.ok) throw new StorageRequestError(result.error);
        const data = result.data as BootstrapShape;
        this.identity = data.mode ?? 'none';
        return data;
    }

    /** F09: the active session itself can serve a same-project reopen — no close, no new lease.
     * Returns the reusable binding, or null when the target differs / nothing is active /
     * the lease was lost / a switch is already in flight. */
    reuseActiveSession(projectId: string): SessionBinding | null {
        if (this.identity !== 'managed' || this.candidate || !this.sessionId) return null;
        if (projectId !== this.projectId || !this.leaseOwned) return null;
        return {
            sessionId: this.sessionId, projectId: this.projectId!, projectName: this.projectName,
            revision: this.revision, current: this.current, leaseOwned: this.leaseOwned,
        };
    }

    /** Stage a candidate session for a project. The active binding is NOT touched; download and
     * first saves run against the candidate until activate() commits the switch. */
    private stageCandidate(data: StorageSessionShape) {
        this.candidate = {
            sessionId: data.sessionId, projectId: data.projectId, projectName: data.name,
            revision: data.revision, current: data.current, leaseOwned: data.leaseOwned,
        };
    }

    /** F04: synchronous single-flight reservation held across an open/create wire await. It is
     * set BEFORE the request leaves, so a second concurrent open/create is refused immediately —
     * two receipts used to both pass assertNoCandidate and the later one overwrote the earlier
     * candidate. */
    private opening = false;

    /** RP7-A3/F04: one candidate at a time. A staged switch — or an open/create receipt that is
     * still in flight — owns the controller until it is committed, compensated or cleaned; a
     * concurrent operation must fail loudly instead of stealing the candidate or having its own
     * late receipt land on the wrong target. */
    private assertNoCandidate(action: string) {
        if (this.candidate || this.opening) {
            const target = this.candidate;
            throw new StorageRequestError({
                code: 'ACTION_FAILED', message: 'storage.v1/switch-in-flight',
                details: [target
                    ? `已有一个进行中的项目切换（${target.projectName ?? target.projectId}），请完成或取消后再${action}`
                    : `已有一个进行中的项目打开/创建操作，请等待其回执后再${action}`],
            });
        }
    }

    /** Open a project session and try to own its write lease. Does NOT confirm identity. */
    async open(projectId: string): Promise<StorageSessionShape> {
        this.assertNoCandidate('打开项目');
        this.opening = true; // F04: reserve synchronously, before the wire await.
        try {
            const result = await this.call!('project.open', { projectId });
            if (!result.ok) throw new StorageRequestError(result.error);
            const data = result.data as StorageSessionShape;
            this.stageCandidate(data);
            return data;
        } finally {
            this.opening = false;
        }
    }

    /** Create an empty managed project session (first save publishes snapshot 1). */
    async create(name: string): Promise<StorageSessionShape> {
        this.assertNoCandidate('创建项目');
        this.opening = true; // F04: reserve synchronously, before the wire await.
        try {
            const result = await this.call!('project.create', { name });
            if (!result.ok) throw new StorageRequestError(result.error);
            const data = result.data as StorageSessionShape;
            this.stageCandidate(data);
            return data;
        } finally {
            this.opening = false;
        }
    }

    /** Confirm the managed identity AFTER the document was downloaded, verified and prepared.
     * F08: the activation receipt promotes the candidate to the active binding atomically — the
     * caller re-checks epoch/revision afterwards and compensates through compensateTo() if the
     * document can no longer be applied. RP7-A3: the receipt is only applied when the staged
     * candidate is STILL this activation's target; a superseded receipt updates nothing. */
    async activate(): Promise<void> {
        const target = this.candidate;
        const sessionId = target?.sessionId ?? this.sessionId;
        if (!sessionId) throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/unknown-session', details: ['没有可激活的会话'] });
        const result = await this.call!('storage.v1.session.activate', { sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        // RP7-R01: the ok receipt is proof the server already persisted this session. Record that
        // fact before deciding whether the local candidate may still be promoted. A closed or
        // replaced candidate must not erase the commit; callers compensate this exact session.
        if (target && this.candidate !== target) {
            throw new StorageRequestError({
                code: 'ACTION_FAILED', message: 'storage.v1/switch-superseded',
                details: ['激活期间已开始其他项目切换，本次激活未应用'],
            }, { sessionId: target.sessionId });
        }
        if (target) {
            this.sessionId = target.sessionId;
            this.projectId = target.projectId;
            this.projectName = target.projectName;
            this.revision = target.revision;
            this.current = target.current;
            this.leaseOwned = target.leaseOwned;
            this.candidate = null;
        }
        this.identity = 'managed';
        // F05: activation alone never lifts an existing unconfirmed block — the receipt lands
        // BEFORE the document is applied, so clearing here would unlock writes for a switch that
        // may still fail and compensate. Only a fully applied switch/reopen ends that state
        // (adoptDownloadedSnapshot after ports.apply succeeded).
    }

    /** RP7-A6: adopt the DOWNLOADED snapshot (SnapshotRef and revision together) after a fully
     * applied open/reopen. The stale pre-open binding revision must never survive a successful
     * reopen (an uncertain save may have landed a newer library revision meanwhile). Only a fully
     * confirmed active session adopts, and adopting ends an unresolved (unconfirmed) state. */
    adoptDownloadedSnapshot(snapshot: SnapshotRefShape): void {
        if (this.identity !== 'managed' || this.candidate || !this.sessionId) return;
        if (snapshot.projectId !== this.projectId) return;
        this.revision = snapshot.revision;
        this.current = snapshot;
        this.unconfirmed = false;
    }

    /** F08 compensation: after activate succeeded but the document could not be applied, restore
     * the persisted choice to `previous` (managed project or unmanaged). Throws on failure — the
     * caller must then mark the state unconfirmed instead of guessing.
     * RP7-R01: when there is no previous managed binding, `ownedSessionId` is the only session this
     * operation may leave. The current candidate or active binding is never used as a guess — a
     * newer operation may own those by the time this receipt arrives. */
    async compensateTo(previous: SessionBinding | null, ownedSessionId?: string | null): Promise<void> {
        try {
            if (previous) {
                const bindingAtSend = this.capture();
                const result = await this.call!('storage.v1.session.activate', { sessionId: previous.sessionId });
                if (!result.ok) throw new StorageRequestError(result.error);
                // A newer switch may have promoted and closed this session while the receipt
                // was in flight. Restoring it then would revive a closed binding over the new one.
                const bindingNow = this.capture();
                if ((bindingNow?.sessionId ?? null) !== (bindingAtSend?.sessionId ?? null)) {
                    this.unconfirmed = true;
                    throw new StorageRequestError({
                        code: 'ACTION_FAILED', message: 'storage.v1/switch-superseded',
                        details: ['补偿回执到达时绑定已变化，原选择未在本地恢复；保存已锁定'],
                    });
                }
                this.restoreBinding(previous);
                this.identity = 'managed';
            } else if (ownedSessionId) {
                const bindingAtSend = this.capture();
                const candidateAtSend = this.candidate;
                const result = await this.call!('storage.v1.session.leave', { sessionId: ownedSessionId });
                if (!result.ok) throw new StorageRequestError(result.error);
                const bindingNow = this.capture();
                if ((bindingNow?.sessionId ?? null) !== (bindingAtSend?.sessionId ?? null)
                    || this.candidate !== candidateAtSend) {
                    this.unconfirmed = true;
                    throw new StorageRequestError({
                        code: 'ACTION_FAILED', message: 'storage.v1/switch-superseded',
                        details: ['离开回执到达时已有更新的会话，未改写其身份；保存已锁定'],
                    });
                }
                if (this.candidate?.sessionId === ownedSessionId) this.candidate = null;
                if (this.sessionId === ownedSessionId) this.resetSession();
                this.identity = 'unmanaged';
            } else {
                // Nothing this operation still owns can be left. Do not invent a session id.
                this.unconfirmed = true;
                throw new StorageRequestError({
                    code: 'ACTION_FAILED', message: 'storage.v1/switch-superseded',
                    details: ['持久选择已提交，但本次会话已关闭，无法安全恢复；保存已锁定'],
                });
            }
            if (this.candidate?.sessionId === ownedSessionId) this.candidate = null;
        } catch (error) {
            // Compensation failed: leave an explicit unconfirmed state; never guess a binding.
            this.unconfirmed = true;
            throw error;
        }
    }

    /** Explicit leave: clears the persisted managed choice and closes the session. RP7-A11: a
     * staged candidate belongs to its own switch operation and is never left by another action. */
    async leave(): Promise<void> {
        this.assertNoCandidate('离开会话');
        const sessionId = this.candidate?.sessionId ?? this.sessionId;
        if (!sessionId) throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/unknown-session', details: ['没有可离开的会话'] });
        const result = await this.call!('storage.v1.session.leave', { sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        this.resetSession();
        this.identity = 'unmanaged';
    }

    /** Close the active session (releases the lease); the persisted choice is untouched. */
    async closeSession(): Promise<void> {
        if (!this.sessionId) return;
        const result = await this.call!('storage.v1.project.close', { sessionId: this.sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        this.resetSession();
    }

    /** Close an arbitrary session by id; drops a matching candidate or the active binding. */
    async closeSessionById(sessionId: string): Promise<void> {
        const result = await this.call!('storage.v1.project.close', { sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        if (this.candidate?.sessionId === sessionId) this.candidate = null;
        if (this.sessionId === sessionId) this.resetSession();
    }

    /** Snapshot the current binding so a failed switch can restore it (session stays alive). */
    capture(): SessionBinding | null {
        if (!this.sessionId) return null;
        return {
            sessionId: this.sessionId, projectId: this.projectId!, projectName: this.projectName,
            revision: this.revision, current: this.current, leaseOwned: this.leaseOwned,
        };
    }

    /** Rebind the controller to a still-open session after a failed switch. */
    restoreBinding(session: SessionBinding) {
        this.sessionId = session.sessionId;
        this.projectId = session.projectId;
        this.projectName = session.projectName;
        this.revision = session.revision;
        this.current = session.current;
        this.leaseOwned = session.leaseOwned;
    }

    /** Download and validate a registered snapshot (current one when no id is given).
     * F08: targets the staged candidate when a switch is in flight, else the active session. */
    async download(snapshotId?: string): Promise<{ document: SceneDocument; snapshot: SnapshotRefShape }> {
        const sessionId = this.candidate?.sessionId ?? this.sessionId;
        const result = await this.call!('storage.v1.snapshot.read', {
            sessionId, ...(snapshotId ? { snapshotId } : {}),
        });
        if (!result.ok) throw new StorageRequestError(result.error);
        const read = result.data as { snapshot: SnapshotRefShape; transferId: string; length: number; chunkSize: number };
        const parts: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const chunk = await this.call!('storage.v1.snapshot.download.chunk', { transferId: read.transferId });
            if (!chunk.ok) throw new StorageRequestError(chunk.error);
            const data = chunk.data as { offset: number; data: string; final: boolean };
            if (data.offset !== received) {
                void this.call!('storage.v1.transfer.abort', { transferId: read.transferId });
                throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/upload-format', details: ['下载块顺序不正确，传输已取消'] });
            }
            const bytes = Uint8Array.from(atob(data.data), character => character.charCodeAt(0));
            received += bytes.length;
            // R8: the accumulated download is bounded by the same 64MiB budget; a hostile stream
            // cannot grow the renderer buffer without end.
            if (received > STORAGE_MAX_PROJECT_BYTES || received > read.length) {
                void this.call!('storage.v1.transfer.abort', { transferId: read.transferId });
                throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/transfer-limit', details: ['下载内容超过长度上限，传输已取消'] });
            }
            parts.push(bytes);
            if (data.final) break;
        }
        const merged = new Uint8Array(received);
        let at = 0;
        for (const part of parts) { merged.set(part, at); at += part.length; }
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder().decode(merged)); }
        catch { throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/corrupt-object', details: ['下载的工程内容不是有效的 JSON'] }); }
        let document: SceneDocument;
        try { document = readSceneDocument(parsed); }
        catch (error) { throw new StorageRequestError({ code: 'ACTION_FAILED', message: 'storage.v1/corrupt-object', details: [error instanceof Error ? error.message : '下载的工程内容校验失败'] }); }
        return { document, snapshot: read.snapshot };
    }

    /** Upload the full document as the next immutable snapshot. Never auto-retries an uncertain
     * commit. F08: the first save of a staged candidate runs against the candidate session and
     * updates the candidate binding; saves without a candidate target the active one.
     * RP7-A8: the controller itself refuses unconfirmed saves at the entry — no upload, and the
     * binding stays exact. The UI check in project-save complements this but never replaces it.
     * RP7-A3: the commit receipt is only applied when the controller still points at the exact
     * target captured at entry; a superseded save never overwrites another candidate or the
     * active binding. */
    async saveSnapshot(document: SceneDocument, name?: string): Promise<SaveOutcome> {
        if (this.unconfirmed) {
            return { status: 'failed', reason: 'unconfirmed', message: '受管状态未确认（此前切换失败且补偿未完成），保存被拒绝；请在项目库中重新打开项目' };
        }
        // RP5: canonicalize BEFORE anything touches the wire. The streaming serializer refuses
        // over-budget documents (upload-too-large) and structurally invalid ones — depth/node
        // limits, non-finite numbers, non-JSON values — (document-invalid) without ever building
        // the full oversized text. These local failures never call upload.begin and never touch
        // revision/current; the canonical byte count is by construction within the frozen budget,
        // so the old post-encode length guard is no longer needed.
        let text: string;
        try {
            text = canonicalJson(document);
        } catch (error) {
            if (error instanceof CanonicalLimitError) {
                if (error.limit === 'bytes') {
                    return { status: 'failed', reason: 'upload-too-large', message: `工程内容超过 ${Math.floor(STORAGE_MAX_PROJECT_BYTES / 1024 / 1024)} MiB 上限，请在项目库中导出 .director 副本` };
                }
                return { status: 'failed', reason: 'document-invalid', message: `工程内容未通过规范化校验：${error.message}` };
            }
            return { status: 'failed', reason: 'document-invalid', message: `工程内容包含无法规范化的值：${error instanceof Error ? error.message : '未知错误'}` };
        }
        // canonicalJson yields no text at all for JSON-invisible roots (undefined/function/symbol).
        // Refuse them here, before anything touches the wire: no upload.begin, and the binding
        // (revision/current) stays untouched.
        if (typeof text !== 'string') {
            return { status: 'failed', reason: 'document-invalid', message: '工程内容不包含可序列化的 JSON 文档' };
        }
        const bytes = new TextEncoder().encode(text);
        const target = this.candidate;
        const targetSessionId = target?.sessionId ?? this.sessionId;
        const expectedRevision = target?.revision ?? this.revision;
        if (!targetSessionId) return { status: 'failed', reason: 'unknown-session', message: '没有打开的受管项目会话' };
        const begin = await this.call!('storage.v1.upload.begin', {
            sessionId: targetSessionId,
            expectedRevision,
            declaredLength: bytes.length,
            ...(name ? { name } : {}),
        });
        if (!begin.ok) return { status: 'failed', reason: new StorageRequestError(begin.error).reason, message: new StorageRequestError(begin.error).message };
        const { transferId, chunkSize } = begin.data as { transferId: string; chunkSize: number };
        try {
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
                const chunk = await this.call!('storage.v1.upload.chunk', { transferId, offset, data: toBase64(slice) });
                if (!chunk.ok) throw new StorageRequestError(chunk.error);
            }
            const commit = await this.call!('storage.v1.upload.commit', { transferId });
            if (!commit.ok) {
                const error = new StorageRequestError(commit.error);
                if (error.reason === 'outcome-unknown') return { status: 'outcome-unknown', message: error.message };
                return { status: 'failed', reason: error.reason, message: error.message };
            }
            const data = commit.data as { snapshot: SnapshotRefShape; revision: number };
            // RP7-A3: only update the binding when it still points at this save's own target.
            const ownsTarget = target ? this.candidate === target : !this.candidate && this.sessionId === targetSessionId;
            if (ownsTarget) {
                if (target) {
                    target.revision = data.revision;
                    target.current = data.snapshot;
                    if (name) target.projectName = name;
                } else {
                    this.revision = data.revision;
                    this.current = data.snapshot;
                    if (name) this.projectName = name;
                }
            }
            return { status: 'saved', snapshot: data.snapshot, revision: data.revision };
        } catch (error) {
            void this.call!('storage.v1.transfer.abort', { transferId });
            if (error instanceof StorageRequestError) return { status: 'failed', reason: error.reason, message: error.message };
            return { status: 'failed', reason: 'io-failure', message: error instanceof Error ? error.message : '保存过程发生未知错误' };
        }
    }

    resetSession() {
        this.sessionId = null;
        this.projectId = null;
        this.projectName = null;
        this.revision = 0;
        this.current = null;
        this.leaseOwned = false;
    }
}

// --- R4/R6 document-identity switch protocol --------------------------------------------------
// Pure decision logic for leaving a managed session before the whole document changes
// (新建/导入). UI wiring (confirm modal, toasts, status line) stays in the callers.

export type SwitchDecision =
    | { status: 'proceed' }
    | { status: 'cancelled'; stage: 'confirm' }
    | { status: 'cancelled'; stage: 'leave'; error: unknown };

export interface ManagedSwitchPorts {
    /** True only while a managed session is active; otherwise nothing to leave. */
    managedActive: boolean;
    /** Unsaved edits that a switch would discard. */
    dirty: boolean;
    /** Unsaved-edits confirmation (receives the switch reason); resolving false cancels. */
    confirmDiscard: (reason: string) => Promise<boolean>;
    /** Drains pending/in-flight legacy autosave writes before the identity changes. */
    drainAutosave: () => Promise<void>;
    /** Explicit managed leave (storage.v1.session.leave via the controller). */
    leave: () => Promise<void>;
}

/** Confirm unsaved edits, drain the autosave queue, then leave the managed session. A refused
 * confirmation or a failed leave cancels the switch so the original document identity, dirty
 * state and lease survive untouched. */
export async function leaveManagedBeforeSwitch(input: ManagedSwitchPorts, reason: string): Promise<SwitchDecision> {
    if (!input.managedActive) return { status: 'proceed' };
    if (input.dirty && !await input.confirmDiscard(reason)) return { status: 'cancelled', stage: 'confirm' };
    try {
        await input.drainAutosave();
        await input.leave();
        return { status: 'proceed' };
    } catch (error) {
        return { status: 'cancelled', stage: 'leave', error };
    }
}

// --- RP7 unified candidate switch protocol -----------------------------------------------------
// One lifecycle for every managed document switch (project-library open, same-project reopen,
// managed startup restore): capture state → confirm once → stage/reuse the candidate → download
// → prepare → re-verify → commit the persisted choice → apply through the RP6 whole-document
// apply → adopt the downloaded revision / compensate → release only what this switch owns.
// UI side effects (toasts, modals, status line, dirty flag) stay in the caller's ports.

export interface ManagedCandidateSwitchPorts {
    /** Current editor revision; captured before the confirmation and compared after awaits. */
    revision(): number;
    /** Unsaved-edits flag at switch entry. */
    dirty(): boolean;
    /** True while a draft, pending history transaction or export forbids the commit. */
    editorBusy(): boolean;
    /** Unsaved-edits confirmation; false cancels with zero side effects (RP7-A2). */
    confirmDiscard(reason: string): Promise<boolean>;
    /** Settles legacy autosave/recovery writes before the commit. */
    drain(): Promise<void>;
    /** Read-only candidate preparation (model preloading); throws = pre-commit failure (A4). */
    prepare(document: SceneDocument): Promise<void>;
    /** RP6 whole-document apply; throws on refused/rolled-back/write-blocked (A5). */
    apply(document: SceneDocument): void;
    /** Clears the editor save-dirty flag after a fully committed switch. */
    markClean(): void;
    /** Progress/failure notifications (toasts). */
    notify(message: string, error?: boolean): void;
}

export type ManagedCandidateSwitchResult =
    | { status: 'committed'; revision: number; reused: boolean }
    | { status: 'cancelled-confirm' }
    | { status: 'cancelled-changed' }
    | { status: 'failed'; error: unknown }
    | { status: 'unconfirmed'; error: unknown };

const SWITCH_MOVED_MESSAGE = '切换期间工程状态已变化，请重试';

/** RP7-A1: the switch state that must stay frozen from entry to commit. `ownedCandidateId` is
 * this switch's own staged candidate (null before open) — any OTHER candidate is an intruder. */
function switchStateIntact(managed: ManagedProjectController, ports: ManagedCandidateSwitchPorts,
    identityBefore: ManagedProjectController['identity'], bindingBefore: SessionBinding | null,
    epochBefore: number, revisionBefore: number, ownedCandidateId: string | null): boolean {
    // F04: `candidate === null` is NOT ownership when this run staged its own candidate — a
    // candidate cleared by another path (close/leave) must abort the switch, not count as
    // "still mine", and a candidate replaced by someone else is an intruder.
    const candidateOwned = ownedCandidateId === null
        ? managed.candidate === null
        : managed.candidate?.sessionId === ownedCandidateId;
    return candidateOwned && !ports.editorBusy() && managed.epoch === epochBefore
        && ports.revision() === revisionBefore && managed.identity === identityBefore
        && sameSessionBinding(managed.capture(), bindingBefore);
}

/** Run the unified managed-candidate switch for `projectId`. Confirmations happen exactly once
 * per user action; every await re-verifies the captured state; pre-commit failures clean only
 * this run's candidate; a post-activate apply failure compensates the persisted choice through
 * compensateTo() and a FAILED compensation leaves the controller explicitly unconfirmed. The
 * document itself is applied exclusively through ports.apply (the RP6 whole-document apply). */
export async function switchManagedCandidate(
    managed: ManagedProjectController,
    projectId: string,
    name: string,
    ports: ManagedCandidateSwitchPorts,
    options: { reason?: string; confirm?: boolean; startup?: boolean } = {},
): Promise<ManagedCandidateSwitchResult> {
    const reason = options.reason ?? '打开其他项目';
    const epochBefore = managed.epoch;
    const revisionBefore = ports.revision();
    const identityBefore = managed.identity;
    const bindingBefore = managed.capture();
    // RP7-A2: the dirty confirmation is the ONLY one per user action and a refusal has zero
    // side effects — no candidate, no persisted choice change, no old-binding change.
    if (options.confirm !== false && ports.dirty() && !await ports.confirmDiscard(reason)) {
        return { status: 'cancelled-confirm' };
    }
    // RP7-A1: the confirmation and every await re-check the captured identity/binding/epoch.
    if (!switchStateIntact(managed, ports, identityBefore, bindingBefore, epochBefore, revisionBefore, null)) {
        return { status: 'cancelled-changed' };
    }
    // F09: a valid active session on the SAME project is reused — no close, no new lease.
    const reuse = managed.reuseActiveSession(projectId);
    let candidateId: string | null = null;
    let committed = false;
    let previous: SessionBinding | null = null;
    try {
        if (!reuse) {
            const session = await managed.open(projectId);
            candidateId = session.sessionId;
            if (session.leaseBusy) throw Error(`项目「${name}」正被其他进程写入，暂不能打开`);
            if (!session.current) throw Error('该项目还没有保存的快照');
            // F04: re-verify before the download targets the staged candidate — the receipt must
            // still own the stage (a candidate cleared meanwhile aborts here, before any read).
            if (!switchStateIntact(managed, ports, identityBefore, bindingBefore, epochBefore, revisionBefore, candidateId)) {
                throw Error(SWITCH_MOVED_MESSAGE);
            }
        }
        const { document, snapshot } = await managed.download();
        await ports.prepare(document);
        if (!switchStateIntact(managed, ports, identityBefore, bindingBefore, epochBefore, revisionBefore, candidateId)) {
            throw Error(SWITCH_MOVED_MESSAGE);
        }
        await ports.drain();
        if (!switchStateIntact(managed, ports, identityBefore, bindingBefore, epochBefore, revisionBefore, candidateId)) {
            throw Error(SWITCH_MOVED_MESSAGE);
        }
        if (reuse) {
            // Same-project reload: session and persisted choice are already correct; nothing to
            // commit or compensate. A failed apply keeps the old revision/current untouched.
            ports.apply(document);
            managed.adoptDownloadedSnapshot(snapshot); // RP7-A6: adopt the DOWNLOADED ref+revision
            ports.markClean();
            return { status: 'committed', revision: managed.revision, reused: true };
        }
        previous = managed.capture();
        try {
            await managed.activate(); // RP7-A2 commit point: the persisted choice moves once
        } catch (activateError) {
            // RP7-R01: an ok receipt means the server already persisted this candidate, even when
            // the local stage was closed before the receipt arrived. That is a committed failure.
            if (activateError instanceof StorageRequestError && activateError.serverCommitted) {
                committed = true;
                candidateId = activateError.committedSessionId ?? candidateId;
            }
            throw activateError;
        }
        committed = true;
        if (managed.sessionId !== candidateId) throw Error('激活期间会话已变化，无法安全应用');
        // F03: the activation await is a state window — the editor may have moved on while the
        // receipt was in flight. Re-verify the captured epoch/revision BEFORE applying; the
        // binding-vs-previous equality is intentionally NOT re-checked here (the activation
        // legitimately moved the binding to this switch's own target — requiring `previous`
        // would fail every legitimate switch, F01). A moved state compensates below.
        if (ports.editorBusy() || managed.epoch !== epochBefore || ports.revision() !== revisionBefore) {
            throw Error(SWITCH_MOVED_MESSAGE);
        }
        ports.apply(document); // RP6 rollback semantics; throws when the document cannot be applied
        managed.adoptDownloadedSnapshot(snapshot);
        ports.markClean();
        // RP7-A11: the previous session is released only after the switch fully committed; a
        // failed release is reported but never turns the committed switch into an uncommitted one.
        if (previous && previous.sessionId !== managed.sessionId) {
            await managed.closeSessionById(previous.sessionId).catch(error => {
                ports.notify(`原会话释放失败（租约将在超时后自动回收）：${error instanceof Error ? error.message : String(error)}`, true);
            });
        }
        return { status: 'committed', revision: managed.revision, reused: false };
    } catch (error) {
        if (!committed) {
            // RP7-A4/F04: pre-commit failures change nothing but this run's candidate — the old
            // document, history, dirty flag, binding, lease and persisted choice stay exact.
            // Only clean what this run still owns: a candidate cleared (and closed) by another
            // path is never closed again, and a replaced candidate belongs to that other run.
            if (candidateId && managed.candidate?.sessionId === candidateId) {
                await managed.closeSessionById(candidateId).catch(() => { });
            }
            return { status: 'failed', error };
        }
        // RP7-A5: activate succeeded but the document could not be applied — compensate the
        // persisted choice; a failed compensation leaves the explicit unconfirmed state (A8).
        try {
            if (options.startup) {
                // RP7-A10/F02: the startup choice was already this same managed project (activate
                // re-persisted it), so there is nothing to compensate and the persisted managed
                // choice must NEVER be flipped to unmanaged (no session.leave). But a bare
                // resetSession() would silently forget the live server session and its lease —
                // close THIS run's candidate explicitly and keep a failed close traceable.
                if (candidateId) {
                    try {
                        await managed.closeSessionById(candidateId);
                        managed.resetSession();
                    } catch (closeError) {
                        // F02: a failed close must not be forgotten behind a reset — keep the
                        // binding pointing at the unclosed session, enter the explicit
                        // unconfirmed state and report the dangling session loudly.
                        managed.unconfirmed = true;
                        ports.notify(`启动恢复失败后候选会话关闭失败（租约将在超时后自动回收，可在项目库重试打开）：${closeError instanceof Error ? closeError.message : String(closeError)}`, true);
                    }
                } else {
                    managed.resetSession();
                }
            } else {
                await managed.compensateTo(previous, candidateId);
            }
            // Close this run's committed session unless a newer operation now owns that id.
            // activate() already cleared it from the stage, so requiring candidate===id skipped
            // every normal post-activate failure. A newer candidate with a different id is kept.
            if (previous && candidateId && candidateId !== managed.sessionId && managed.candidate?.sessionId !== candidateId) {
                await managed.closeSessionById(candidateId).catch(() => { });
            }
            return { status: 'failed', error };
        } catch (compensationError) {
            return { status: 'unconfirmed', error: compensationError };
        }
    }
}

// --- RP7/F01 create-from-current protocol -------------------------------------------------------
// Same candidate lifecycle as switchManagedCandidate, but the document is NOT replaced: the
// current document is published as the new project's first snapshot and only the managed
// identity/binding moves. UI side effects (toasts, status line, modal) stay in the caller.

export interface ManagedCreatePorts {
    /** Current editor revision; captured at entry and re-compared after every await. */
    revision(): number;
    /** The document to publish as the candidate's first snapshot; read after the candidate
     * session exists (the same timing as the pre-RP7 create flow). */
    document(): SceneDocument;
    /** Clears the editor save-dirty flag after the switch fully committed. */
    markClean(): void;
    /** Progress/failure notifications (toasts). */
    notify(message: string, error?: boolean): void;
}

export type ManagedCreateResult =
    | { status: 'committed'; revision: number; snapshot: SnapshotRefShape }
    | { status: 'save-unknown' }
    | { status: 'save-failed'; message: string }
    | { status: 'stale-saved' }
    | { status: 'failed'; error: unknown }
    | { status: 'unconfirmed'; error: unknown };

/** RP7/F01: create a managed project from the CURRENT document and move the persisted choice to
 * it in one lifecycle. No apply port exists by design — the document, its history and the dirty
 * editor state are never reset; only the managed binding moves, and only after the first
 * snapshot really landed. The activation verification is "THIS create's target became the
 * current binding" — never "the binding still equals the pre-create previous" (a new sessionId
 * always differs, so the old check failed every legitimate create, including from a plain
 * session). Genuine epoch/revision races during the activation still compensate. The previous
 * managed session is released only after the full success (RP7-A11). */
export async function createManagedFromCurrent(
    managed: ManagedProjectController,
    name: string,
    ports: ManagedCreatePorts,
): Promise<ManagedCreateResult> {
    const epochBefore = managed.epoch;
    const revisionBefore = ports.revision();
    const identityBefore = managed.identity;
    const bindingBefore = managed.capture();
    let candidateId: string | null = null;
    let committed = false;
    let previous: SessionBinding | null = null;
    // F04: only close the session this run still owns — a candidate cleared elsewhere was
    // already closed by that path, and a replaced candidate belongs to another operation.
    const releaseOwnCandidate = async () => {
        if (candidateId && managed.candidate?.sessionId === candidateId) {
            await managed.closeSessionById(candidateId).catch(() => { });
        }
    };
    try {
        const session = await managed.create(name); // F04: single-flight reservation inside
        candidateId = session.sessionId;
        const staged = managed.candidate;
        const document = ports.document();
        const outcome = await managed.saveSnapshot(document, name);
        if (outcome.status === 'outcome-unknown') {
            await releaseOwnCandidate();
            return { status: 'save-unknown' };
        }
        if (outcome.status !== 'saved') {
            await releaseOwnCandidate();
            return { status: 'save-failed', message: outcome.message };
        }
        if (managed.epoch !== epochBefore || ports.revision() !== revisionBefore
            || managed.identity !== identityBefore || managed.candidate !== staged
            || !sameSessionBinding(managed.capture(), bindingBefore)) {
            // Stale captured edit state — release only this run's candidate; the snapshot stays
            // in the library but the persisted switch is not committed.
            await releaseOwnCandidate();
            return { status: 'stale-saved' };
        }
        previous = managed.capture();
        try {
            await managed.activate(); // commit point: the persisted choice moves to the candidate once
        } catch (activateError) {
            // RP7-R01: same commit fact as the open path. The receipt names this create's session;
            // compensation below may leave only that id, never a later candidate.
            if (activateError instanceof StorageRequestError && activateError.serverCommitted) {
                committed = true;
                candidateId = activateError.committedSessionId ?? candidateId;
            }
            throw activateError;
        }
        committed = true;
        // F01: verify the TARGET binding became the current one — not that it still equals the
        // pre-activation previous — then re-check the editor epoch/revision for races.
        if (managed.sessionId !== candidateId || !staged
            || !sameSessionBinding(managed.capture(), staged)) {
            throw Error('激活期间会话已变化，无法安全提交切换');
        }
        if (managed.epoch !== epochBefore || ports.revision() !== revisionBefore) {
            throw Error('激活后工程状态已变化，无法安全提交切换');
        }
        ports.markClean();
        // RP7-A11: the previous session is released only after the full success; a failed
        // release is reported without turning the committed switch into an uncommitted one.
        if (previous && previous.sessionId !== managed.sessionId) {
            await managed.closeSessionById(previous.sessionId).catch(error => {
                ports.notify(`原会话释放失败（租约将在超时后自动回收）：${error instanceof Error ? error.message : String(error)}`, true);
            });
        }
        return { status: 'committed', revision: managed.revision, snapshot: outcome.snapshot };
    } catch (error) {
        if (!committed) {
            await releaseOwnCandidate();
            return { status: 'failed', error };
        }
        // F01: post-activate failures (target check / epoch-revision race) compensate the
        // committed persisted choice; a failed compensation leaves the explicit unconfirmed
        // state and never closes the session that choice points at (F08/A5).
        try {
            await managed.compensateTo(previous, candidateId);
            // F01: the committed candidate session is no longer the persisted choice — release
            // it explicitly by id. compensateTo(null) already left it (unmanaged restore); a
            // managed restore re-activated `previous` and leaves this run's session open, and
            // the post-activate candidate===null makes releaseOwnCandidate a no-op there.
            if (candidateId && previous && candidateId !== managed.sessionId && managed.candidate?.sessionId !== candidateId) {
                await managed.closeSessionById(candidateId).catch(() => { });
            }
            return { status: 'failed', error };
        } catch (compensationError) {
            return { status: 'unconfirmed', error: compensationError };
        }
    }
}
