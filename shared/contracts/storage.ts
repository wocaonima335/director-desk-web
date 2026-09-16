// DSK-004: storage.v1.* action namespace (approved contract increment on the frozen dsk.v1
// envelope). The original dsk.v1 pipeline actions, their payloads, the SnapshotRef shape and the
// generic single-message IPC limits are unchanged; everything here is additive and strict.
// Business failures use the ACTION_FAILED code plus one frozen `storage.v1/<reason>` token in
// `message`; never absolute paths, stacks or lease owner randomness.
// Pure module: no DOM, Electron, Node or filesystem imports.
import { z } from 'zod';
import { DSK_CONTRACT_VERSION } from './version.ts';
import { DskErrorSchema, IdSchema, SnapshotRefSchema } from './schema.ts';

const version = z.literal(DSK_CONTRACT_VERSION);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const isoTimestamp = z.iso.datetime({ offset: true });

// --- Approved transfer limits (plan section 4). Generic IPC limits are NOT relaxed. ---
export const STORAGE_MAX_PROJECT_BYTES = 64 * 1024 * 1024; // one upload payload / canonical JSON
export const STORAGE_CHUNK_BYTES = 48 * 1024; // decoded bytes per chunk (base64 stays under 256KiB chars)
export const STORAGE_MAX_DEPTH = 64; // project document scan depth (deeper than generic IPC scan)
export const STORAGE_MAX_NODES = 1000000; // project document node budget
export const STORAGE_UPLOAD_IDLE_MS = 60000;
export const STORAGE_TRANSFER_TOTAL_MS = 600000;
export const STORAGE_MAX_TRANSFERS_PER_FRAME = 1; // one upload AND one download per frame session
export const STORAGE_LEASE_TTL_MS = 30000;
export const STORAGE_LEASE_RENEW_MS = 10000;
export const STORAGE_BACKUP_MAX_SNAPSHOTS = 10000;
export const STORAGE_BACKUP_MAX_BYTES = 10 * 1024 * 1024 * 1024;
// 48KiB decodes to exactly 65536 base64 chars; small slack for padding of tail chunks.
export const STORAGE_CHUNK_B64_CHARS = Math.ceil((STORAGE_CHUNK_BYTES * 4) / 3) + 8;

// --- Frozen business failure reasons (closed set; message is `storage.v1/<reason>`) ---
export const STORAGE_FAILURE_REASONS = [
    'lease-busy', 'lease-lost', 'lease-expired', 'revision-conflict',
    'unknown-session', 'unknown-transfer', 'unknown-project', 'unknown-snapshot', 'frame-mismatch',
    'transfer-limit', 'upload-format', 'document-invalid', 'timeout', 'outcome-unknown',
    'corrupt-object', 'schema-unsupported', 'integrity-failed', 'backup-invalid', 'path-refused',
    'dialog-cancelled', 'io-failure', 'database-locked', 'storage-unavailable',
] as const;
export type StorageFailureReason = (typeof STORAGE_FAILURE_REASONS)[number];

export const isStorageFailureReason = (value: string): value is StorageFailureReason =>
    (STORAGE_FAILURE_REASONS as readonly string[]).includes(value);

// Action list: additive namespace on the same director-dsk channel and dsk.v1 envelope.
export const STORAGE_ACTIONS = [
    'storage.v1.project.list', 'storage.v1.project.close',
    'storage.v1.session.bootstrap', 'storage.v1.session.activate', 'storage.v1.session.leave',
    'storage.v1.upload.begin', 'storage.v1.upload.chunk', 'storage.v1.upload.commit',
    'storage.v1.transfer.abort',
    'storage.v1.snapshot.read', 'storage.v1.snapshot.download.chunk',
    'storage.v1.backup.create', 'storage.v1.backup.restore',
] as const;
export type DskStorageAction = (typeof STORAGE_ACTIONS)[number];

const base64Chunk = z.string().max(STORAGE_CHUNK_B64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9+/]*$/, '必须是 base64 文本');

// --- Strict input schemas (original pipeline payloads untouched) ---
export const STORAGE_ACTION_PAYLOAD_SCHEMAS = {
    'storage.v1.project.list': z.strictObject({
        cursor: z.string().max(128).optional(),
        limit: integer(1, 200).optional(),
    }),
    'storage.v1.project.close': z.strictObject({ sessionId: IdSchema }),
    'storage.v1.session.bootstrap': z.strictObject({}),
    'storage.v1.session.activate': z.strictObject({ sessionId: IdSchema }),
    'storage.v1.session.leave': z.strictObject({ sessionId: IdSchema }),
    'storage.v1.upload.begin': z.strictObject({
        sessionId: IdSchema,
        expectedRevision: integer(0, 1000000),
        declaredLength: integer(1, STORAGE_MAX_PROJECT_BYTES),
        name: z.string().min(1).max(80).optional(),
    }),
    'storage.v1.upload.chunk': z.strictObject({
        transferId: IdSchema,
        offset: integer(0, STORAGE_MAX_PROJECT_BYTES - 1),
        data: base64Chunk,
    }),
    'storage.v1.upload.commit': z.strictObject({ transferId: IdSchema }),
    'storage.v1.transfer.abort': z.strictObject({ transferId: IdSchema }),
    'storage.v1.snapshot.read': z.strictObject({ sessionId: IdSchema, snapshotId: IdSchema.optional() }),
    'storage.v1.snapshot.download.chunk': z.strictObject({ transferId: IdSchema }),
    'storage.v1.backup.create': z.strictObject({ projectId: IdSchema }),
    'storage.v1.backup.restore': z.strictObject({}),
} as const satisfies Record<DskStorageAction, z.ZodType>;

export type DskStorageActionPayloads = { [A in DskStorageAction]: z.infer<(typeof STORAGE_ACTION_PAYLOAD_SCHEMAS)[A]> };

// --- Strict result schemas (handlers self-check every success payload against these) ---
export const ProjectSummarySchema = z.strictObject({
    projectId: IdSchema,
    name: z.string().min(1).max(80),
    revision: integer(0, 1000000),
    current: SnapshotRefSchema.nullable(),
    updatedAt: isoTimestamp,
});
export const ProjectIntegritySchema = z.strictObject({
    objects: integer(0, 1000000),
    missing: integer(0, 1000000),
    corrupt: integer(0, 1000000),
    orphans: integer(0, 1000000),
});
export const ProjectLeaseStateSchema = z.strictObject({
    owned: z.boolean(),
    busy: z.boolean(),
    generation: integer(1, 1000000000).optional(),
});
export const ProjectStatusSchema = z.strictObject({
    projectId: IdSchema,
    name: z.string().min(1).max(80),
    revision: integer(0, 1000000),
    current: SnapshotRefSchema.nullable(),
    updatedAt: isoTimestamp,
    integrity: ProjectIntegritySchema,
    lease: ProjectLeaseStateSchema,
});
export const StorageSessionSchema = z.strictObject({
    sessionId: IdSchema,
    projectId: IdSchema,
    name: z.string().min(1).max(80),
    revision: integer(0, 1000000),
    current: SnapshotRefSchema.nullable(),
    leaseOwned: z.boolean(),
    leaseBusy: z.boolean(),
});
export const SessionBootstrapResultSchema = z.strictObject({
    mode: z.enum(['managed', 'unmanaged']).nullable(),
    projectId: IdSchema.nullable(),
    name: z.string().min(1).max(80).nullable(),
});
export const SessionActivateResultSchema = z.strictObject({
    mode: z.literal('managed'),
    sessionId: IdSchema,
    projectId: IdSchema,
});
export const SessionLeaveResultSchema = z.strictObject({ mode: z.literal('unmanaged') });
export const ProjectListResultSchema = z.strictObject({
    projects: z.array(ProjectSummarySchema).max(200),
    nextCursor: z.string().max(128).nullable(),
});
export const UploadBeginResultSchema = z.strictObject({
    transferId: IdSchema,
    declaredLength: integer(1, STORAGE_MAX_PROJECT_BYTES),
    chunkSize: integer(1, STORAGE_CHUNK_BYTES),
});
export const UploadChunkResultSchema = z.strictObject({ received: integer(1, STORAGE_MAX_PROJECT_BYTES) });
export const UploadCommitResultSchema = z.strictObject({
    snapshot: SnapshotRefSchema,
    revision: integer(1, 1000000),
});
export const TransferAbortResultSchema = z.strictObject({ aborted: z.literal(true) });
export const SnapshotReadResultSchema = z.strictObject({
    snapshot: SnapshotRefSchema,
    transferId: IdSchema,
    length: integer(1, STORAGE_MAX_PROJECT_BYTES),
    chunkSize: integer(1, STORAGE_CHUNK_BYTES),
    chunks: integer(1, 1000000),
});
export const DownloadChunkResultSchema = z.strictObject({
    offset: integer(0, STORAGE_MAX_PROJECT_BYTES - 1),
    data: base64Chunk,
    final: z.boolean(),
});
export const BackupCreateResultSchema = z.strictObject({
    cancelled: z.literal(true),
}).or(z.strictObject({
    projectId: IdSchema,
    name: z.string().min(1).max(80),
    snapshots: integer(1, STORAGE_BACKUP_MAX_SNAPSHOTS),
    objects: integer(1, 1000000),
    bytes: integer(1, STORAGE_BACKUP_MAX_BYTES),
}));
export const BackupRestoreResultSchema = z.strictObject({
    projectId: IdSchema,
    name: z.string().min(1).max(80),
    snapshots: integer(1, STORAGE_BACKUP_MAX_SNAPSHOTS),
    revision: integer(1, 1000000),
});

export const STORAGE_RESULT_SCHEMAS = {
    'storage.v1.project.list': ProjectListResultSchema,
    'storage.v1.project.close': z.strictObject({ closed: z.literal(true) }),
    'storage.v1.session.bootstrap': SessionBootstrapResultSchema,
    'storage.v1.session.activate': SessionActivateResultSchema,
    'storage.v1.session.leave': SessionLeaveResultSchema,
    'storage.v1.upload.begin': UploadBeginResultSchema,
    'storage.v1.upload.chunk': UploadChunkResultSchema,
    'storage.v1.upload.commit': UploadCommitResultSchema,
    'storage.v1.transfer.abort': TransferAbortResultSchema,
    'storage.v1.snapshot.read': SnapshotReadResultSchema,
    'storage.v1.snapshot.download.chunk': DownloadChunkResultSchema,
    'storage.v1.backup.create': BackupCreateResultSchema,
    'storage.v1.backup.restore': BackupRestoreResultSchema,
} as const satisfies Record<DskStorageAction, z.ZodType>;

// Result schemas for the original pipeline actions that DSK-004 implements for real. Frozen now
// that they return validated data instead of NOT_IMPLEMENTED.
export const PIPELINE_STORAGE_RESULT_SCHEMAS = {
    'project.list': z.strictObject({ projects: z.array(ProjectSummarySchema).max(200) }),
    'project.status': ProjectStatusSchema,
    'project.open': StorageSessionSchema,
    'project.create': StorageSessionSchema,
} as const;

export type DskStorageResults = { [A in DskStorageAction]: z.infer<(typeof STORAGE_RESULT_SCHEMAS)[A]> };

// Frozen backup manifest (strict; restore rejects anything else). Directory payload carries no paths.
export const BackupManifestSchema = z.strictObject({
    version: z.literal('director-desk-backup.v1'),
    contractVersion: version,
    sourceProjectId: IdSchema,
    name: z.string().min(1).max(80),
    createdAt: isoTimestamp,
    snapshots: z.array(z.strictObject({
        snapshotId: IdSchema,
        revision: integer(1, 1000000),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        length: integer(1, STORAGE_MAX_PROJECT_BYTES),
        createdAt: isoTimestamp,
    })).min(1).max(STORAGE_BACKUP_MAX_SNAPSHOTS),
    objects: z.array(z.strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        length: integer(1, STORAGE_MAX_PROJECT_BYTES),
    })).min(1).max(1000000),
});

export type StorageBackupManifest = z.infer<typeof BackupManifestSchema>;

// Shared helper for handlers: ACTION_FAILED + frozen storage.v1/<reason>, human detail in details.
export function storageFailure(reason: StorageFailureReason, detail: string): { ok: false; error: z.infer<typeof DskErrorSchema> } {
    return { ok: false, error: { code: 'ACTION_FAILED', message: `storage.v1/${reason}`, details: [detail.slice(0, 200)] } };
}

// Bounded scan for uploaded project JSON: finite numbers, no prototype-smuggling keys, depth 64,
// 1M nodes. Mirrors scanDskPayload semantics with the storage-specific budget (pure, iterative).
export function scanStorageProject(value: unknown): string | null {
    const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
    let nodes = 0;
    while (queue.length) {
        const item = queue.pop()!;
        nodes += 1;
        if (nodes > STORAGE_MAX_NODES) return '工程负载节点数超过上限';
        if (item.d > STORAGE_MAX_DEPTH) return '工程负载嵌套深度超过 64 层';
        const v = item.v;
        if (typeof v === 'number' && !Number.isFinite(v)) return '工程负载包含 NaN 或 Infinity';
        if (typeof v === 'string' && v.length > 32 * 1024 * 1024) return '工程负载包含超大字符串';
        if (Array.isArray(v)) {
            for (const entry of v) queue.push({ v: entry, d: item.d + 1 });
        } else if (v !== null && typeof v === 'object') {
            for (const key of Object.keys(v as Record<string, unknown>)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') return '工程负载包含被禁止的原型键';
                queue.push({ v: (v as Record<string, unknown>)[key], d: item.d + 1 });
            }
        }
    }
    return null;
}
