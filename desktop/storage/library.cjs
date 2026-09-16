// DSK-004: managed project library on Electron's built-in node:sqlite (no new dependencies).
// Schema v1 only: schema_migrations / projects / snapshots / project_leases / app_state.
// Empty databases initialize to v1; anything else is identified READ-ONLY first (exact tables,
// column order/types/constraints, no authored indexes, no triggers/views, migration row) and
// refused — the file is never modified, rebuilt or migrated, and write PRAGMAs only run after a
// positive identification. Snapshot registration and the trusted current pointer move in ONE
// immediate transaction guarded by owner+generation+expiry+revision; the commit phase is
// classified separately (before-commit failure vs post-commit uncertainty verified by snapshot
// id), and lease clocks are sampled inside the transaction so lock waits cannot misread expiry.
// API verified on Node 22.14 and the Electron 44.2 embedded runtime: no boolean binds, no db.backup.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
// Data-level migration marker; the structural truth is the exact column/constraint verification below.
const SCHEMA_FINGERPRINT = 'dsk-storage-v1';

const SCHEMA_DDL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  current_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  snapshot_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, revision)
);
CREATE TABLE project_leases (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  project_id TEXT,
  name TEXT,
  updated_at TEXT NOT NULL
);
`;

// Exact v1 structure. Order, type, NOT NULL and PK must match pragma table_info verbatim.
const EXPECTED_TABLES = {
    schema_migrations: [
        { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
        { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0 },
    ],
    projects: [
        { name: 'project_id', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'current_snapshot_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ],
    snapshots: [
        { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'snapshot_id', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'digest', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'length', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
    ],
    project_leases: [
        { name: 'project_id', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'owner', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'generation', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ],
    app_state: [
        { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
        { name: 'mode', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ],
};
// Backup databases carry only the necessary project/snapshot/version tables.
const BACKUP_TABLES = ['schema_migrations', 'projects', 'snapshots'];

function refuse(cause) {
    return Object.assign(Error('项目库结构不受支持或已损坏，已拒绝写入且不会重建'), { reason: 'schema-unsupported', cause: String(cause).slice(0, 160) });
}

function normalizeType(type) {
    return String(type ?? '').toUpperCase();
}

/** Read-only structural verification against the exact expected v1 shape (R1). */
function verifyStructure(db, { backup = false } = {}) {
    const structures = db.prepare('SELECT type, name, sql FROM sqlite_master').all();
    const expected = backup ? BACKUP_TABLES : Object.keys(EXPECTED_TABLES);
    const tables = structures.filter(row => row.type === 'table').map(row => row.name).filter(name => name !== 'sqlite_sequence');
    if (tables.length !== expected.length || !expected.every(name => tables.includes(name))) {
        throw refuse(`表集合不符: ${tables.sort().join(',')}`);
    }
    for (const structure of structures) {
        if (structure.type === 'table') continue; // exact columns checked per table below
        if (structure.type === 'index' && (structure.sql === null || structure.sql === undefined)) continue; // automatic indexes only
        throw refuse(`出现${structure.type === 'view' ? '视图' : structure.type === 'trigger' ? '触发器' : '自建索引'}: ${structure.name}`);
    }
    for (const tableName of expected) {
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => ({
            name: column.name, type: normalizeType(column.type), notnull: Number(column.notnull), pk: Number(column.pk),
        }));
        const wanted = EXPECTED_TABLES[tableName];
        if (columns.length !== wanted.length || columns.some((column, index) =>
            column.name !== wanted[index].name || column.type !== wanted[index].type
            || column.notnull !== wanted[index].notnull || column.pk !== wanted[index].pk)) {
            throw refuse(`表 ${tableName} 列/约束不符: ${columns.map(c => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).join(',')}`);
        }
    }
    const migrations = db.prepare('SELECT version, fingerprint, applied_at FROM schema_migrations').all();
    if (migrations.length !== 1 || Number(migrations[0].version) !== SCHEMA_VERSION
        || migrations[0].fingerprint !== SCHEMA_FINGERPRINT
        || typeof migrations[0].applied_at !== 'string' || migrations[0].applied_at.length < 20) {
        throw refuse(`迁移记录不符: ${JSON.stringify(migrations).slice(0, 120)}`);
    }
}

function nowIso(now) {
    return new Date(now()).toISOString();
}

function isSqliteError(error) {
    return !!error && typeof error === 'object' && (error.errcode !== undefined || /SQLITE/i.test(String(error.errstr || error.message || '')));
}

/** Open (or create) the library file and guarantee schema v1. faults.open injects failures. */
function openLibrary({ file, now = () => Date.now(), faults = {} }) {
    if (faults.open) throw faults.open();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // R1: identify BEFORE any write-capable handle or PRAGMA touches an existing file. A read-only
    // open cannot modify the database; identification failure leaves the original bytes intact.
    if (fs.existsSync(file)) {
        let probe;
        try {
            probe = new DatabaseSync(file, { readOnly: true });
        } catch (error) {
            throw refuse(`只读识别失败（不做任何写入）: ${error && error.message}`);
        }
        try {
            verifyStructure(probe);
        } catch (error) {
            try { probe.close(); } catch { /* ignore */ }
            if (error && error.reason === 'schema-unsupported') throw error;
            throw refuse(`只读识别失败（不做任何写入）: ${error && error.message}`);
        }
        try { probe.close(); } catch { /* ignore */ }
    }
    let db;
    try {
        db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA busy_timeout = 2000');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA synchronous = FULL');
    } catch (error) {
        try { if (db) db.close(); } catch { /* ignore */ }
        throw refuse(String(error && error.message || error));
    }
    try {
        db.exec('BEGIN IMMEDIATE');
        const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all().map(row => row.name);
        if (!tables.length) {
            db.exec(SCHEMA_DDL);
            db.prepare('INSERT INTO schema_migrations (version, fingerprint, applied_at) VALUES (?, ?, ?)')
                .run(SCHEMA_VERSION, SCHEMA_FINGERPRINT, nowIso(now));
        } else {
            // TOCTOU guard: re-verify under the write lock before handing the handle out.
            verifyStructure(db);
        }
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* not in transaction */ }
        try { db.close(); } catch { /* ignore */ }
        if (error && error.reason === 'schema-unsupported') throw error;
        throw refuse(String(error && error.message || error));
    }
    return wrapDatabase(db, { now, faults });
}

/** Wrap the raw DatabaseSync with transaction helpers and normalized storage errors. */
function wrapDatabase(db, { now, faults }) {
    const storageError = (reason, message) => Object.assign(Error(message), { reason });
    const runImmediate = fn => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* already rolled back or closed */ }
            throw error;
        }
    };
    const runDeferred = fn => {
        db.exec('BEGIN');
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* ignore */ }
            throw error;
        }
    };
    const normalize = error => {
        if (error && error.reason) throw error;
        if (isSqliteError(error) && /database is locked|busy/i.test(String(error.message))) {
            throw storageError('database-locked', '项目库正被其他写入占用，请稍后重试');
        }
        throw storageError('storage-unavailable', '项目库访问失败，已拒绝本次操作');
    };
    return {
        raw: db,

        /** One consistent read view (WAL readers never block writers). */
        readView(fn) {
            try { return runDeferred(fn); } catch (error) { normalize(error); }
        },

        /** Register a snapshot and move the trusted pointer under lease+revision guards.
         * The stored revision is derived as expectedRevision+1 inside the same transaction.
         * The COMMIT phase is classified separately (R9): a throw after COMMIT started means the
         * outcome is uncertain and must be resolved by the pre-generated snapshot id — never
         * reported as a plain retryable failure while the pointer may already have moved.
         * hooks.commitReceipt runs right after COMMIT (fault injection). */
        commitSnapshot({ projectId, owner, generation, expectedRevision, snapshot, now: atNow }, hooks = {}) {
            const revision = Number(expectedRevision) + 1;
            if (!Number.isInteger(revision) || revision < 1 || revision > 1000000) {
                throw storageError('revision-conflict', '快照版本超出范围');
            }
            const insert = db.prepare('INSERT INTO snapshots (project_id, snapshot_id, revision, digest, length, created_at) VALUES (?, ?, ?, ?, ?, ?)');
            const update = db.prepare('UPDATE projects SET revision = ?, current_snapshot_id = ?, updated_at = ? WHERE project_id = ?');
            const lease = db.prepare('SELECT owner, generation, expires_at FROM project_leases WHERE project_id = ?');
            const current = db.prepare('SELECT revision FROM projects WHERE project_id = ?');
            const verifyRow = () => {
                const row = this.readView(() => db.prepare('SELECT revision, digest FROM snapshots WHERE snapshot_id = ?').get(snapshot.snapshotId));
                if (row && row.digest === snapshot.digest) return { committed: true };
                if (!row) throw storageError('io-failure', '提交结果未确认，快照未登记；请重新保存');
                throw storageError('outcome-unknown', '提交结果不确定，请先查询项目状态，不要盲目重试');
            };
            let commitStarted = false;
            let committed = false;
            try {
                runImmediate(() => {
                    const leaseRow = lease.get(projectId);
                    if (!leaseRow || leaseRow.owner !== owner || leaseRow.generation !== generation) {
                        throw storageError('lease-lost', '写入租约已失效，请重新打开项目后再保存');
                    }
                    if (leaseRow.expires_at <= atNow()) {
                        throw storageError('lease-expired', '写入租约已过期，请重新打开项目后再保存');
                    }
                    const currentRow = current.get(projectId);
                    if (!currentRow) throw storageError('unknown-project', '项目不存在');
                    if (Number(currentRow.revision) !== Number(expectedRevision)) {
                        throw storageError('revision-conflict', '项目已被其他保存更新，请刷新后重试');
                    }
                    insert.run(projectId, snapshot.snapshotId, revision, snapshot.digest, snapshot.length, snapshot.createdAt);
                    update.run(revision, snapshot.snapshotId, snapshot.createdAt, projectId);
                    commitStarted = true; // everything below (COMMIT) is uncertainty territory
                });
                committed = true;
            } catch (error) {
                if (error && error.reason) throw error;
                if (commitStarted) {
                    // The COMMIT statement itself threw. Either it landed (verify sees the row) or
                    // it did not; if verification cannot run, the outcome stays unknown.
                    try { return verifyRow(); }
                    catch (verifyError) {
                        if (verifyError && verifyError.reason === 'outcome-unknown') throw verifyError;
                        if (verifyError && verifyError.reason === 'io-failure') throw verifyError;
                        throw storageError('outcome-unknown', '提交结果不确定（查证失败），请先查询项目状态，不要盲目重试');
                    }
                }
                normalize(error);
            }
            if (hooks.commitReceipt) {
                try {
                    hooks.commitReceipt(); // may simulate an uncertain crash AFTER the real commit
                } catch (error) {
                    if (error && error.reason) throw error;
                    try { return verifyRow(); }
                    catch (verifyError) {
                        if (verifyError && (verifyError.reason === 'outcome-unknown' || verifyError.reason === 'io-failure')) throw verifyError;
                        throw storageError('outcome-unknown', '提交结果不确定（查证失败），请先查询项目状态，不要盲目重试');
                    }
                }
            }
            return { committed };
        },

        /** Lease acquisition inside BEGIN IMMEDIATE; the clock is sampled INSIDE the transaction
         * (R10) so a busy_timeout wait cannot classify expiry with a stale timestamp. Expired
         * leases are taken over with generation+1. */
        acquireLease(projectId, ttlMs) {
            try {
                return runImmediate(() => {
                    const atNow = now();
                    const row = db.prepare('SELECT owner, generation, expires_at FROM project_leases WHERE project_id = ?').get(projectId);
                    if (row && row.owner && row.expires_at > atNow) return { acquired: false, busy: true };
                    const generation = row ? Number(row.generation) + 1 : 1;
                    const owner = require('node:crypto').randomUUID();
                    db.prepare('INSERT INTO project_leases (project_id, owner, generation, expires_at) VALUES (?, ?, ?, ?) ' +
                        'ON CONFLICT (project_id) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, expires_at = excluded.expires_at')
                        .run(projectId, owner, generation, atNow + ttlMs);
                    return { acquired: true, busy: false, owner, generation, expiresAt: atNow + ttlMs };
                });
            } catch (error) { normalize(error); }
        },

        renewLease(projectId, owner, generation, ttlMs) {
            try {
                return runImmediate(() => {
                    const atNow = now(); // R10: read the clock after the write lock is held
                    const row = db.prepare('SELECT owner, generation, expires_at FROM project_leases WHERE project_id = ?').get(projectId);
                    if (!row || row.owner !== owner || row.generation !== generation) return { renewed: false, lost: true };
                    if (row.expires_at <= atNow) return { renewed: false, lost: true };
                    db.prepare('UPDATE project_leases SET expires_at = ? WHERE project_id = ?').run(atNow + ttlMs, projectId);
                    return { renewed: true };
                });
            } catch (error) { normalize(error); }
        },

        releaseLease(projectId, owner, generation) {
            try {
                return runImmediate(() => {
                    // Tombstone: keep the generation counter, clear the owner and expire the lease.
                    const info = db.prepare('UPDATE project_leases SET owner = \'\', expires_at = 0 WHERE project_id = ? AND owner = ? AND generation = ?')
                        .run(projectId, owner, generation);
                    return { released: Number(info.changes) > 0 };
                });
            } catch (error) { normalize(error); }
        },

        leaseState(projectId) {
            const row = db.prepare('SELECT owner, generation, expires_at FROM project_leases WHERE project_id = ?').get(projectId);
            if (!row) return { present: false };
            return { present: true, generation: Number(row.generation), expiresAt: Number(row.expires_at), expired: row.expires_at <= now() };
        },

        createProject({ projectId, name }) {
            const at = nowIso(now);
            try {
                return runImmediate(() => {
                    db.prepare('INSERT INTO projects (project_id, name, revision, current_snapshot_id, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)')
                        .run(projectId, name, at, at);
                    return { projectId, name, revision: 0, current: null };
                });
            } catch (error) { normalize(error); }
        },

        renameProject(projectId, name) {
            const at = nowIso(now);
            try {
                return runImmediate(() => {
                    const info = db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE project_id = ?').run(name, at, projectId);
                    return { renamed: Number(info.changes) > 0 };
                });
            } catch (error) { normalize(error); }
        },

        getProject(projectId) {
            const row = db.prepare('SELECT project_id, name, revision, current_snapshot_id, created_at, updated_at FROM projects WHERE project_id = ?').get(projectId);
            if (!row) return null;
            const snapshot = row.current_snapshot_id
                ? db.prepare('SELECT snapshot_id, revision, digest, length, created_at FROM snapshots WHERE snapshot_id = ? AND project_id = ?').get(row.current_snapshot_id, projectId)
                : undefined;
            return {
                projectId: row.project_id,
                name: row.name,
                revision: Number(row.revision),
                current: snapshot ? {
                    version: 'dsk.v1',
                    snapshotId: snapshot.snapshot_id,
                    projectId,
                    revision: Number(snapshot.revision),
                    digest: snapshot.digest,
                    createdAt: snapshot.created_at,
                } : null,
                updatedAt: row.updated_at,
            };
        },

        listProjects({ cursor, limit }) {
            const cap = Math.min(Math.max(limit ?? 100, 1), 200);
            const rows = cursor !== undefined
                ? db.prepare('SELECT project_id, name, revision, current_snapshot_id, created_at, updated_at FROM projects WHERE project_id > ? ORDER BY project_id LIMIT ?').all(cursor, cap + 1)
                : db.prepare('SELECT project_id, name, revision, current_snapshot_id, created_at, updated_at FROM projects ORDER BY project_id LIMIT ?').all(cap + 1);
            const page = rows.slice(0, cap).map(row => {
                const snapshot = row.current_snapshot_id
                    ? db.prepare('SELECT snapshot_id, revision, digest, length, created_at FROM snapshots WHERE snapshot_id = ? AND project_id = ?').get(row.current_snapshot_id, row.project_id)
                    : undefined;
                return {
                    projectId: row.project_id,
                    name: row.name,
                    revision: Number(row.revision),
                    current: snapshot ? {
                        version: 'dsk.v1',
                        snapshotId: snapshot.snapshot_id,
                        projectId: row.project_id,
                        revision: Number(snapshot.revision),
                        digest: snapshot.digest,
                        createdAt: snapshot.created_at,
                    } : null,
                    updatedAt: row.updated_at,
                };
            });
            return { projects: page, nextCursor: rows.length > cap ? page[page.length - 1].projectId : null };
        },

        listSnapshots(projectId) {
            return db.prepare('SELECT snapshot_id, revision, digest, length, created_at FROM snapshots WHERE project_id = ? ORDER BY revision').all(projectId)
                .map(row => ({ snapshotId: row.snapshot_id, revision: Number(row.revision), digest: row.digest, length: Number(row.length), createdAt: row.created_at }));
        },

        getSnapshot(projectId, snapshotId) {
            const row = db.prepare('SELECT snapshot_id, revision, digest, length, created_at FROM snapshots WHERE project_id = ? AND snapshot_id = ?').get(projectId, snapshotId);
            return row ? { snapshotId: row.snapshot_id, revision: Number(row.revision), digest: row.digest, length: Number(row.length), createdAt: row.created_at } : null;
        },

        /** Last confirmed session choice; null when never set. */
        getlastSession() {
            const row = db.prepare('SELECT mode, project_id, name FROM app_state WHERE id = 1').get();
            return row ? { mode: row.mode, projectId: row.project_id ?? null, name: row.name ?? null } : null;
        },

        setLastSession(mode, projectId, name) {
            const at = nowIso(now);
            try {
                return runImmediate(() => {
                    db.prepare('INSERT INTO app_state (id, mode, project_id, name, updated_at) VALUES (1, ?, ?, ?, ?) ' +
                        'ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, project_id = excluded.project_id, name = excluded.name, updated_at = excluded.updated_at')
                        .run(mode, projectId, name, at);
                    return true;
                });
            } catch (error) { normalize(error); }
        },

        /** Consistent metadata snapshot for backups: project + snapshots in one read view. */
        backupView(projectId) {
            return this.readView(() => {
                const project = this.getProject(projectId);
                if (!project) throw storageError('unknown-project', '项目不存在');
                return { project, snapshots: this.listSnapshots(projectId) };
            });
        },

        /** Restore registration: one transaction inserts project + all remapped snapshots. */
        restoreProject({ project, snapshots }) {
            try {
                return runImmediate(() => {
                    db.prepare('INSERT INTO projects (project_id, name, revision, current_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
                        .run(project.projectId, project.name, project.revision, project.currentSnapshotId, project.createdAt, project.updatedAt);
                    const insert = db.prepare('INSERT INTO snapshots (project_id, snapshot_id, revision, digest, length, created_at) VALUES (?, ?, ?, ?, ?, ?)');
                    for (const snapshot of snapshots) insert.run(project.projectId, snapshot.snapshotId, snapshot.revision, snapshot.digest, snapshot.length, snapshot.createdAt);
                    return true;
                });
            } catch (error) { normalize(error); }
        },

        close() {
            try { db.close(); } catch { /* already closed */ }
        },
    };
}

// Backup databases carry ONLY the necessary project/snapshot/version schema (no leases, no
// app_state, no triggers or views) so a restore can whitelist the exact structure.
const BACKUP_DDL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  current_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  snapshot_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, revision)
);
`;

/** Build an isolated, immediately-complete backup database in one pass. */
function createBackupDatabase(file, { project, snapshots, createdAt }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) throw Object.assign(Error('备份暂存目录已包含数据库'), { reason: 'backup-invalid' });
    const db = new DatabaseSync(file);
    try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(BACKUP_DDL);
        db.prepare('INSERT INTO schema_migrations (version, fingerprint, applied_at) VALUES (?, ?, ?)')
            .run(SCHEMA_VERSION, SCHEMA_FINGERPRINT, createdAt);
        db.prepare('INSERT INTO projects (project_id, name, revision, current_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(project.projectId, project.name, project.revision, project.currentSnapshotId, project.createdAt, project.updatedAt);
        const insert = db.prepare('INSERT INTO snapshots (project_id, snapshot_id, revision, digest, length, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const snapshot of snapshots) insert.run(project.projectId, snapshot.snapshotId, snapshot.revision, snapshot.digest, snapshot.length, snapshot.createdAt);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
    } finally {
        db.close();
    }
}

/** Restore-side read-only inspection of a backup database (R1/R3): exact structure whitelist AND
 * row-closure checks — one project row, every snapshot row belongs to it. Never executes
 * backup-provided SQL; unknown tables, views, triggers, columns reject the backup. */
function inspectBackupDatabase(file) {
    if (!fs.existsSync(file)) throw Object.assign(Error('备份数据库缺失'), { reason: 'backup-invalid' });
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true });
        verifyStructure(db, { backup: true });
        const projectRows = db.prepare('SELECT project_id, name, revision, current_snapshot_id, created_at, updated_at FROM projects').all();
        if (projectRows.length !== 1) throw Object.assign(Error('备份必须恰好包含一个项目'), { reason: 'backup-invalid' });
        const row = projectRows[0];
        const snapshotRows = db.prepare('SELECT project_id, snapshot_id, revision, digest, length, created_at FROM snapshots').all();
        // R3: hidden rows from other projects must not ride along inside the backup database.
        if (snapshotRows.some(s => s.project_id !== row.project_id)) {
            throw Object.assign(Error('备份快照存在跨项目数据行'), { reason: 'backup-invalid' });
        }
        return {
            project: {
                sourceProjectId: row.project_id,
                name: row.name,
                revision: Number(row.revision),
                currentSnapshotId: row.current_snapshot_id,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            },
            snapshots: snapshotRows
                .map(s => ({ snapshotId: s.snapshot_id, revision: Number(s.revision), digest: s.digest, length: Number(s.length), createdAt: s.created_at }))
                .sort((a, b) => a.revision - b.revision),
        };
    } catch (error) {
        if (error && (error.reason === 'schema-unsupported' || error.reason === 'backup-invalid')) throw error;
        throw Object.assign(Error('备份数据库无法读取'), { reason: 'backup-invalid' });
    } finally {
        try { if (db) db.close(); } catch { /* never opened */ }
    }
}

module.exports = { openLibrary, inspectBackupDatabase, createBackupDatabase, SCHEMA_VERSION, SCHEMA_FINGERPRINT };
