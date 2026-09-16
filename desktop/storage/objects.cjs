// DSK-004: content-addressed immutable project object store.
// Layout: <root>/projects/<projectId>/objects/<sha256>.json holding the canonical document bytes.
// Publication order: write tmp file -> flush -> close -> rename on the same directory -> sync dir.
// A file only exists under its final digest name after the bytes are durable; readers verify size
// and digest before trusting content. Missing/corrupt/orphan objects are reported, never repaired
// or silently deleted. Pure Node: no Electron imports; fs/clock/random are injectable for tests.
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const OBJECT_EXT = '.json';

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function projectDir(root, projectId) {
    // projectId is validated by the contract layer ([A-Za-z0-9][A-Za-z0-9._-]{0,63}); the guard
    // here keeps path traversal out even if a caller forgets.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectId)) throw Error('项目标识无效');
    return path.join(root, 'projects', projectId, 'objects');
}

function tmpName() {
    return `.tmp-${process.pid}-${crypto.randomUUID()}`;
}

/** Create one object store rooted at <root>/projects. faults.{write,sync,close,rename} inject I/O failures. */
function createObjectStore({ root, faults = {} }) {
    const call = (hook, fallback) => hook ? hook() : fallback();
    return {
        root,
        sha256Hex,

        /** Write canonical bytes, publish under <digest>.json; returns { digest, length }.
         * R2: an object that already exists under its digest name must prove its content — same
         * length alone is NOT enough; a tampered file is reported corrupt and never overwritten
         * or repaired. Symbolic links/junctions are refused on every touched path. */
        async putObject(projectId, bytes) {
            const digest = sha256Hex(bytes);
            const dir = projectDir(root, projectId);
            await fsp.mkdir(dir, { recursive: true });
            const finalPath = path.join(dir, digest + OBJECT_EXT);
            let existingStat;
            try { existingStat = await fsp.lstat(finalPath); } catch { existingStat = null; }
            if (existingStat) {
                if (existingStat.isSymbolicLink()) {
                    throw Object.assign(Error('同名对象路径是符号链接或 junction'), { reason: 'path-refused' });
                }
                if (!existingStat.isFile()) {
                    throw Object.assign(Error('同名对象路径不是普通文件'), { reason: 'corrupt-object' });
                }
                // Immutable store: verify the existing bytes actually hash to the digest name.
                const existing = await fsp.readFile(finalPath);
                if (existing.length !== bytes.length || sha256Hex(existing) !== digest) {
                    throw Object.assign(Error('同名对象内容与摘要不符，已拒绝写入且不覆盖'), { reason: 'corrupt-object' });
                }
                return { digest, length: bytes.length };
            }
            const tmpPath = path.join(dir, tmpName());
            let handle;
            try {
                handle = await call(faults.write, () => fsp.open(tmpPath, 'wx'));
                await handle.writeFile(bytes);
                await call(faults.sync, () => handle.sync());
                await call(faults.close, () => handle.close());
            } catch (error) {
                try { if (handle) await handle.close(); } catch { /* best effort */ }
                try { await fsp.unlink(tmpPath); } catch { /* best effort */ }
                throw error;
            }
            try {
                await call(faults.rename, () => fsp.rename(tmpPath, finalPath));
            } catch (error) {
                try { await fsp.unlink(tmpPath); } catch { /* best effort */ }
                throw error;
            }
            return { digest, length: bytes.length };
        },

        /** Read and verify one object; throws with a stable reason on missing/corrupt content.
         * Symlink/junction indirection on the object path is refused (same policy as writes). */
        async getObject(projectId, digest, expectedLength) {
            if (!/^[0-9a-f]{64}$/.test(digest)) throw Object.assign(Error('对象摘要无效'), { reason: 'corrupt-object' });
            const file = path.join(projectDir(root, projectId), digest + OBJECT_EXT);
            let linkStat;
            try { linkStat = await fsp.lstat(file); } catch { linkStat = null; }
            if (linkStat && linkStat.isSymbolicLink()) {
                throw Object.assign(Error('对象路径是符号链接或 junction'), { reason: 'path-refused' });
            }
            let bytes;
            try {
                bytes = await fsp.readFile(file);
            } catch (error) {
                if (error && error.code === 'ENOENT') throw Object.assign(Error('登记的对象文件缺失'), { reason: 'corrupt-object' });
                throw Object.assign(Error('对象文件不可读'), { reason: 'io-failure' });
            }
            if (expectedLength !== undefined && bytes.length !== expectedLength) {
                throw Object.assign(Error('对象长度与登记值不符'), { reason: 'corrupt-object' });
            }
            if (sha256Hex(bytes) !== digest) throw Object.assign(Error('对象内容摘要不匹配'), { reason: 'corrupt-object' });
            return bytes;
        },

        /** Cheap existence+size map for every file in one project: { digest: {size} }, plus orphan count. */
        async listObjects(projectId) {
            const dir = projectDir(root, projectId);
            const files = new Map();
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch (error) {
                if (error && error.code === 'ENOENT') return { files, orphans: 0 };
                throw error;
            }
            for (const entry of entries) {
                const match = /^([0-9a-f]{64})\.json$/.exec(entry);
                if (!match) continue;
                const full = path.join(dir, entry);
                let stat;
                try { stat = await fsp.lstat(full); } catch { continue; }
                if (stat.isSymbolicLink()) continue; // never follow or count links in the store
                files.set(match[1], stat.size);
            }
            let orphans = 0;
            for (const entry of entries) {
                if (!/^([0-9a-f]{64})\.json$/.test(entry) && !entry.startsWith('.tmp-')) orphans += 1;
            }
            return { files, orphans };
        },

        /** Full integrity check of one project against its registered snapshots. */
        async verifyProject(projectId, snapshots) {
            const { files, orphans: orphanCount } = await this.listObjects(projectId);
            let missing = 0, corrupt = 0;
            let orphans = orphanCount;
            const registered = new Set();
            for (const snapshot of snapshots) {
                registered.add(snapshot.digest);
                const size = files.get(snapshot.digest);
                if (size === undefined) { missing += 1; continue; }
                try {
                    const bytes = await this.getObject(projectId, snapshot.digest, snapshot.length);
                    JSON.parse(bytes.toString('utf8'));
                } catch {
                    corrupt += 1;
                }
            }
            for (const digest of files.keys()) if (!registered.has(digest)) orphans += 1;
            return { objects: files.size, missing, corrupt, orphans };
        },

        /** Copy one verified object into another project directory (restore). */
        async copyObject(fromProject, toProject, digest, expectedLength) {
            const bytes = await this.getObject(fromProject, digest, expectedLength);
            return await this.putObject(toProject, bytes);
        },

        /** Stream one object of this store to an arbitrary file (backup), verifying length and
         * digest while streaming (R8: no full-buffer read of the object). */
        async streamObjectToFile(projectId, digest, expectedLength, destPath) {
            const source = path.join(projectDir(root, projectId), digest + OBJECT_EXT);
            const linkStat = await fsp.lstat(source).catch(() => null);
            if (linkStat && linkStat.isSymbolicLink()) {
                throw Object.assign(Error('对象路径是符号链接或 junction'), { reason: 'path-refused' });
            }
            const hash = crypto.createHash('sha256');
            let seen = 0;
            const guard = new fsSync.ReadStream(source, { highWaterMark: 1 << 20 });
            guard.on('data', chunk => {
                seen += chunk.length;
                if (seen > expectedLength) guard.destroy(Object.assign(Error('对象超过登记长度'), { reason: 'corrupt-object' }));
                hash.update(chunk);
            });
            try {
                await pipeline(guard, fsSync.createWriteStream(destPath, { flags: 'wx', highWaterMark: 1 << 20 }));
            } catch (error) {
                try { await fsp.rm(destPath, { force: true }); } catch { /* best effort */ }
                if (error && error.reason) throw error;
                throw Object.assign(Error('对象流式复制失败'), { reason: 'io-failure' });
            }
            if (seen !== expectedLength || hash.digest('hex') !== digest) {
                try { await fsp.rm(destPath, { force: true }); } catch { /* best effort */ }
                throw Object.assign(Error('对象流式校验失败（长度或摘要）'), { reason: 'corrupt-object' });
            }
            return { digest, length: seen };
        },

        /** Stream a verified backup file into this store as an object (restore), verifying length
         * and digest while streaming, then publishing through the same immutable path as
         * putObject (R8/R2: no full-buffer copy, existing objects must prove their content). */
        async streamFileToObject(sourcePath, projectId, expectedDigest, expectedLength) {
            const dir = projectDir(root, projectId);
            await fsp.mkdir(dir, { recursive: true });
            const finalPath = path.join(dir, expectedDigest + OBJECT_EXT);
            const existingStat = await fsp.lstat(finalPath).catch(() => null);
            if (existingStat && existingStat.isSymbolicLink()) {
                throw Object.assign(Error('同名对象路径是符号链接或 junction'), { reason: 'path-refused' });
            }
            if (existingStat) {
                // Existing object must prove its content before the copy result is discarded.
                const existing = await fsp.readFile(finalPath);
                if (existing.length !== expectedLength || sha256Hex(existing) !== expectedDigest) {
                    throw Object.assign(Error('同名对象内容与摘要不符，已拒绝写入且不覆盖'), { reason: 'corrupt-object' });
                }
                return { digest: expectedDigest, length: existing.length };
            }
            const hash = crypto.createHash('sha256');
            let seen = 0;
            const guard = new fsSync.ReadStream(sourcePath, { highWaterMark: 1 << 20 });
            guard.on('data', chunk => {
                seen += chunk.length;
                if (seen > expectedLength) guard.destroy(Object.assign(Error('备份对象超过登记长度'), { reason: 'corrupt-object' }));
                hash.update(chunk);
            });
            const tmpPath = path.join(dir, tmpName());
            try {
                await pipeline(guard, fsSync.createWriteStream(tmpPath, { flags: 'wx', highWaterMark: 1 << 20 }));
            } catch (error) {
                try { await fsp.rm(tmpPath, { force: true }); } catch { /* best effort */ }
                if (error && error.reason) throw error;
                throw Object.assign(Error('备份对象流式复制失败'), { reason: 'io-failure' });
            }
            if (seen !== expectedLength || hash.digest('hex') !== expectedDigest) {
                try { await fsp.rm(tmpPath, { force: true }); } catch { /* best effort */ }
                throw Object.assign(Error('备份对象流式校验失败（长度或摘要）'), { reason: 'corrupt-object' });
            }
            try {
                await fsp.rename(tmpPath, finalPath);
            } catch (error) {
                try { await fsp.rm(tmpPath, { force: true }); } catch { /* best effort */ }
                throw Object.assign(Error('备份对象发布失败'), { reason: 'io-failure' });
            }
            return { digest: expectedDigest, length: seen };
        },

        /** Remove a whole project directory (restore rollback of a fresh, never-registered dir). */
        async removeProject(projectId) {
            await fsp.rm(projectDir(root, projectId), { recursive: true, force: true });
        },
    };
}

module.exports = { createObjectStore, sha256Hex, projectDir };
