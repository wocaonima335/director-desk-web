// DSK-004: renderer-side managed project session controller.
// Owns the managed/unmanaged session identity, the storage.v1 wire flow (open/download/save) and
// the epoch counter that lets async completions detect "the editor moved on". No DOM, no Engine:
// every UI side effect stays in the callers (project-save / project-library / main). Validation of
// downloaded documents reuses the shared readSceneDocument verifier.
import type { SceneDocument } from '../scenes/sequence-project.ts';
import { readSceneDocument } from '../scenes/sequence-project.ts';
import { STORAGE_MAX_PROJECT_BYTES } from '../../shared/contracts/index.ts';

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
    constructor(error: DskErrorShape) {
        super(error.details?.[0] || error.message || '存储操作失败');
        this.name = 'StorageRequestError';
        this.reason = error.message.startsWith('storage.v1/') ? error.message.slice('storage.v1/'.length) : 'storage-unavailable';
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(binary);
}

export class ManagedProjectController {
    /** none: 未选择；managed: 显式确认的受管会话；unmanaged: 显式离开后的普通会话。 */
    identity: 'none' | 'managed' | 'unmanaged' = 'none';
    sessionId: string | null = null;
    projectId: string | null = null;
    projectName: string | null = null;
    revision = 0;
    current: SnapshotRefShape | null = null;
    leaseOwned = false;
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

    /** Open a project session and try to own its write lease. Does NOT confirm identity. */
    async open(projectId: string): Promise<StorageSessionShape> {
        const result = await this.call!('project.open', { projectId });
        if (!result.ok) throw new StorageRequestError(result.error);
        const data = result.data as StorageSessionShape;
        this.sessionId = data.sessionId;
        this.projectId = data.projectId;
        this.projectName = data.name;
        this.revision = data.revision;
        this.current = data.current;
        this.leaseOwned = data.leaseOwned;
        return data;
    }

    /** Create an empty managed project session (first save publishes snapshot 1). */
    async create(name: string): Promise<StorageSessionShape> {
        const result = await this.call!('project.create', { name });
        if (!result.ok) throw new StorageRequestError(result.error);
        const data = result.data as StorageSessionShape;
        this.sessionId = data.sessionId;
        this.projectId = data.projectId;
        this.projectName = data.name;
        this.revision = data.revision;
        this.current = data.current;
        this.leaseOwned = data.leaseOwned;
        return data;
    }

    /** Confirm the managed identity AFTER the document was downloaded, verified and prepared. */
    async activate(): Promise<void> {
        const result = await this.call!('storage.v1.session.activate', { sessionId: this.sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        this.identity = 'managed';
    }

    /** Explicit leave: clears the persisted managed choice and closes the session. */
    async leave(): Promise<void> {
        const result = await this.call!('storage.v1.session.leave', { sessionId: this.sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        this.resetSession();
        this.identity = 'unmanaged';
    }

    /** Close the current session (releases the lease); the persisted choice is untouched. */
    async closeSession(): Promise<void> {
        if (!this.sessionId) return;
        const result = await this.call!('storage.v1.project.close', { sessionId: this.sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
        this.resetSession();
    }

    /** Close an arbitrary session by id (used to release a failed switch target or an old session). */
    async closeSessionById(sessionId: string): Promise<void> {
        const result = await this.call!('storage.v1.project.close', { sessionId });
        if (!result.ok) throw new StorageRequestError(result.error);
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

    /** Download and validate a registered snapshot (current one when no id is given). */
    async download(snapshotId?: string): Promise<{ document: SceneDocument; snapshot: SnapshotRefShape }> {
        const result = await this.call!('storage.v1.snapshot.read', {
            sessionId: this.sessionId, ...(snapshotId ? { snapshotId } : {}),
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

    /** Upload the full document as the next immutable snapshot. Never auto-retries an uncertain commit. */
    async saveSnapshot(document: SceneDocument, name?: string): Promise<SaveOutcome> {
        const bytes = new TextEncoder().encode(JSON.stringify(document));
        if (bytes.length > STORAGE_MAX_PROJECT_BYTES) {
            return { status: 'failed', reason: 'upload-too-large', message: `工程内容超过 ${Math.floor(STORAGE_MAX_PROJECT_BYTES / 1024 / 1024)} MiB 上限，请在项目库中导出 .director 副本` };
        }
        if (!this.sessionId) return { status: 'failed', reason: 'unknown-session', message: '没有打开的受管项目会话' };
        const begin = await this.call!('storage.v1.upload.begin', {
            sessionId: this.sessionId,
            expectedRevision: this.revision,
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
            this.revision = data.revision;
            this.current = data.snapshot;
            if (name) this.projectName = name;
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
