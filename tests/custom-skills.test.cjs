const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { skillPackage, localPackage, relativeFile } = require('../desktop/skills/package.cjs');
const { createSkillStore } = require('../desktop/skills/store.cjs');
const { githubSource, githubPackage } = require('../desktop/skills/github.cjs');
const { referenceFiles } = require('../scripts/builtin-skill-files.cjs');
const builtin = { name: 'director-desk', version: 'builtin-v1', instructions: 'BUILTIN_BODY' };
const pack = text => skillPackage([{ path: 'SKILL.md', bytes: Buffer.from('---\nname: 自定义创作\ndescription: >-\n  按要求创作\n  和调整表演\n---\n' + text) },
    { path: 'references/example.md', bytes: Buffer.from('附属说明') }, { path: 'scripts/helper.cjs', bytes: Buffer.from('throw Error("must never execute")') }]);
async function temporary(fn) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'director-skills-'));
    try { await fn(directory); } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^director-skills-/);
        await fs.rm(directory, { recursive: true, force: true });
    }
}
test('built-in references stay in memory, bypass only root version skipping, and honor the enabled switch', () => temporary(async directory => {
    const references = Object.fromEntries(referenceFiles.map(file => [file, 'REFERENCE: ' + file]));
    const embedded = { ...builtin, references }, store = createSkillStore({ directory, builtin: embedded });
    const files = ['SKILL.md', ...referenceFiles];
    assert.deepEqual((await store.list())[0].files, files);
    assert.equal((await store.read({ knownVersion: builtin.version })).unchanged, true);
    for (const file of files) {
        const result = await store.tool({ path: file, knownVersion: builtin.version });
        assert.equal(result.unchanged, false); assert.equal(result.path, file);
        assert.equal(result.instructions, file === 'SKILL.md' ? builtin.instructions : references[file]);
        assert.equal(Object.hasOwn(result, 'references'), false);
    }
    await assert.rejects(fs.stat(path.join(directory, 'skills')), { code: 'ENOENT' }, 'Reading built-in references creates no local copies');
    for (const file of ['', '../secret', 'references/../SKILL.md', '/absolute', 'C:/secret', 'references\\camera.md', 'references/Camera.md', '__proto__', 'constructor', 'scripts/project-tool.mjs'])
        await assert.rejects(store.tool({ path: file, knownVersion: builtin.version }), /路径|没有这个文件/, file);
    await store.enable('builtin', false);
    assert.deepEqual((await store.tool({ action: 'list' })).skills, []);
    await assert.rejects(store.tool({ path: referenceFiles[0], knownVersion: builtin.version }), /停用/);
    assert.equal((await store.read({ path: referenceFiles[0] }, true)).instructions, references[referenceFiles[0]]);
    const reloaded = createSkillStore({ directory, builtin: embedded });
    await assert.rejects(reloaded.read({ path: 'SKILL.md' }), /停用/);
    await reloaded.enable('builtin', true);
    assert.equal((await reloaded.read()).instructions, builtin.instructions);
}));
test('skills import, enable/disable, version reload and removal persist independently of the source', () => temporary(async directory => {
    let store = createSkillStore({ directory, builtin });
    await store.install(pack('正文v1'));
    let entries = await store.list(); const id = entries.find(e => !e.builtin).id;
    const first = await store.read({ id }); assert.match(first.instructions, /正文v1/);
    assert.equal((await store.read({ id, knownVersion: first.version })).unchanged, true);
    assert.equal((await store.read({ id, path: 'references/example.md', knownVersion: first.version })).instructions, '附属说明');
    assert.match((await store.read({ id, path: 'scripts/helper.cjs' })).instructions, /must never execute/);
    assert.match(entries.find(e => e.id === id).description, /按要求创作 和调整表演/);
    await store.enable(id, false); await assert.rejects(store.read({ id }), /停用/);
    assert.match((await store.read({ id }, true)).instructions, /正文v1/);
    await store.enable('builtin', false); assert.deepEqual((await store.tool({ action: 'list' })).skills, []);
    await assert.rejects(store.tool({ action: 'remove', id }), /参数/);
    store = createSkillStore({ directory, builtin }); assert.ok((await store.list()).every(e => !e.enabled));
    await store.install(pack('正文v2'), '本地导入', id);
    entries = await store.list(); assert.equal(entries.length, 2); assert.equal(entries[1].enabled, false);
    await store.enable(id, true); const second = await store.read({ id, knownVersion: first.version });
    assert.equal(second.unchanged, false); assert.notEqual(second.version, first.version);
    assert.match(second.instructions, /正文v2/);
    const folder = await store.folder(id); await store.remove(id); await assert.rejects(fs.stat(folder));
    assert.equal((await store.list()).length, 1); await assert.rejects(store.remove('builtin'), /停用/);
}));
test('package failures leave the old skill intact; file traversal and symlinks cannot expose host files', () => temporary(async directory => {
    const source = path.join(directory, 'source'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'SKILL.md'), '# 源技能\n保留原文件');
    const store = createSkillStore({ directory: path.join(directory, 'profile'), builtin });
    await store.install(await localPackage(source)); const id = (await store.list())[1].id;
    const first = await store.read({ id });
    await assert.rejects(store.install({ files: [{ path: '../SKILL.md', bytes: Buffer.from('bad') }] }, 'invalid', id), /路径/);
    assert.deepEqual(await store.read({ id }), first);
    for (const file of ['../secret', 'a/../../secret', '/absolute', 'C:/secret', 'a\\secret', 'nul.txt', 'a./b']) assert.throws(() => relativeFile(file));
    await assert.rejects(store.read({ id, path: '../secret' }), /路径/);
    await store.remove(id); assert.match(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), /保留原文件/);
    await store.install(pack('附件测试')); const linkedId = (await store.list())[1].id;
    const owned = await store.folder(linkedId), outside = path.join(directory, 'outside');
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'example.md'), '包外内容');
    await fs.unlink(path.join(owned, 'references/example.md')); await fs.rmdir(path.join(owned, 'references'));
    await fs.symlink(outside, path.join(owned, 'references'), 'junction');
    await assert.rejects(store.read({ id: linkedId, path: 'references/example.md' }), /包外/);
    await assert.rejects(localPackage(owned), /符号链接/);
    assert.throws(() => skillPackage([{ path: 'SKILL.md', bytes: Buffer.from('# a') }, { path: 'skill.md', bytes: Buffer.from('# b') }]), /重复/);
}));
test('GitHub skill download stays within the selected public directory and includes references', async () => {
    const requests = [];
    const downloaded = await githubPackage('https://github.com/example/skills/tree/main/my-skill', async (url, options) => {
        requests.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
        const file = new URL(url).pathname.split('/contents/')[1];
        const data = {
            'my-skill': [{ name: 'SKILL.md', type: 'file', size: 20 }, { name: 'references', type: 'dir' }],
            'my-skill/SKILL.md': '# 下载技能\n参考 references/guide.md',
            'my-skill/references': [{ name: 'guide.md', type: 'file', size: 10 }],
            'my-skill/references/guide.md': '本技能资料',
        }[file];
        assert.ok(data); return new Response(typeof data === 'string' ? data : JSON.stringify(data));
    });
    assert.equal(downloaded.package.name, '下载技能'); assert.equal(downloaded.package.files.length, 2);
    assert.ok(requests.every(url => url.startsWith('https://api.github.com/repos/example/skills/contents/my-skill')));
    assert.equal(githubSource('https://github.com/example/skills/blob/main/my-skill/SKILL.md').folder, 'my-skill');
    for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://x@y.example/a/b', 'file:///secret']) assert.throws(() => githubSource(url));
    await assert.rejects(githubPackage('https://github.com/example/skills', async () => new Response('', { status: 403 })), /额度/);
});
