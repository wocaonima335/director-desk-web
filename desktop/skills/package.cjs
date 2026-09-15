const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');

const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 1000;
function relativeFile(value) {
    if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\') || value.split('/').some(s => !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) throw Error('技能文件路径无效');
    return value;
}
function skillPackage(files) {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw Error('技能包需要文件，最多 1000 个');
    const names = new Set(); let size = 0;
    for (const file of files) {
        relativeFile(file.path);
        const key = file.path.toLowerCase();
        if (names.has(key)) throw Error('技能包内文件名重复'); names.add(key);
        if (!Buffer.isBuffer(file.bytes)) throw Error('技能文件内容无效');
        size += file.bytes.length; if (size > MAX_BYTES) throw Error('技能包超过 50 MB');
    }
    const entry = files.find(f => f.path.toLowerCase() === 'skill.md');
    if (!entry) throw Error('所选目录根部没有 SKILL.md，请选择具体技能目录');
    const text = entry.bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (text.includes('\0') || !text.trim()) throw Error('SKILL.md 需要 UTF-8 文本');
    let metadata = {}, body = text;
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (header) {
        try { metadata = yaml.load(header[1], { schema: yaml.FAILSAFE_SCHEMA }) || {}; } catch { throw Error('SKILL.md 的 YAML 信息格式错误'); }
        body = text.slice(header[0].length);
    }
    const name = String(metadata.name || body.match(/^#\s+(.+)$/m)?.[1] || '自定义技能').trim();
    const description = String(metadata.description || '').trim();
    if (!name || name.length > 200 || description.length > 5000) throw Error('技能名称或描述过长');
    const hash = createHash('sha256');
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) hash.update(JSON.stringify([file.path, file.bytes.length])).update(file.bytes);
    return { name, description, version: hash.digest('hex').slice(0, 20), files, size, instructions: text, entry: entry.path };
}
async function localPackage(selected) {
    const info = await fs.lstat(selected); if (info.isSymbolicLink()) throw Error('请选择实际技能文件或目录');
    if (info.isFile()) return skillPackage([{ path: 'SKILL.md', bytes: await readBounded(selected) }]);
    if (!info.isDirectory()) throw Error('请选择技能文件或目录');
    const files = []; let size = 0;
    async function walk(directory, prefix = '') {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
            if (entry.isSymbolicLink()) throw Error('技能目录包含符号链接，请移除链接后导入');
            const relative = relativeFile(prefix + entry.name), absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(absolute, relative + '/');
            else if (entry.isFile()) {
                const bytes = await readBounded(absolute); size += bytes.length;
                if (size > MAX_BYTES || files.length >= MAX_FILES) throw Error('技能包超过 50 MB 或 1000 个文件');
                files.push({ path: relative, bytes });
            }
        }
    }
    await walk(selected); return skillPackage(files);
}
async function readBounded(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('技能文件无效或超过 50 MB');
    return fs.readFile(file);
}
module.exports = { MAX_BYTES, MAX_FILES, relativeFile, skillPackage, localPackage };
