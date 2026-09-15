const { skillPackage, relativeFile, MAX_BYTES, MAX_FILES } = require('./package.cjs');

function githubSource(value) {
    let url; try { url = new URL(value); } catch { throw Error('请输入 GitHub 技能目录链接'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw Error('请使用公开 github.com 仓库或技能目录的 HTTPS 链接');
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
    const [owner, repo, mode, ref, ...rest] = parts;
    if (!/^[a-z0-9_.-]+$/i.test(owner || '') || !/^[a-z0-9_.-]+$/i.test(repo || '') || mode && !['tree', 'blob'].includes(mode) || mode && !ref) throw Error('GitHub 链接格式无效');
    const folder = (mode === 'blob' && /\/SKILL\.md$/i.test(url.pathname) ? rest.slice(0, -1) : rest).join('/');
    if (mode === 'blob' && !/\/SKILL\.md$/i.test(url.pathname)) throw Error('文件链接需要指向 SKILL.md');
    if (folder) relativeFile(folder);
    return { owner, repo: repo.replace(/\.git$/, ''), ref, folder, url: url.href };
}
async function githubPackage(value, fetcher = fetch) {
    const source = githubSource(value), files = [];
    let bytes = 0, requests = 0;
    const signal = AbortSignal.timeout(120000);
    async function request(relative, raw = false) {
        if (++requests > MAX_FILES + 100) throw Error('技能目录过大，请选择更具体的技能目录');
        const url = new URL(`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${relative.split('/').map(encodeURIComponent).join('/')}`);
        if (source.ref) url.searchParams.set('ref', source.ref);
        const response = await fetcher(url.href, { signal, redirect: 'error', headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' } });
        if (!response.ok) throw Error(response.status === 403 || response.status === 429 ? 'GitHub 访问额度暂时受限，可下载后本地导入' : `GitHub 下载失败（${response.status}），请检查公开仓库和技能目录链接`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES || raw && bytes + size > MAX_BYTES) throw Error('技能包超过 50 MB'); chunks.push(Buffer.from(chunk)); }
        return Buffer.concat(chunks);
    }
    async function walk(folder, prefix = '') {
        const entries = JSON.parse((await request(folder)).toString('utf8'));
        if (!Array.isArray(entries) || entries.length >= 1000) throw Error('请选择包含 SKILL.md 的具体技能目录');
        if (!prefix && !entries.some(e => e.name?.toLowerCase() === 'skill.md' && e.type === 'file')) throw Error('目录中没有 SKILL.md，请使用具体技能目录链接');
        for (const entry of entries) {
            if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
            relativeFile(entry.name); if (entry.name.includes('/')) throw Error('GitHub 返回了无效文件名');
            const relative = prefix + entry.name, remote = (folder ? folder + '/' : '') + entry.name;
            if (entry.type === 'dir') await walk(remote, relative + '/');
            else if (entry.type === 'file' && !entry.submodule_git_url && entry.size <= MAX_BYTES) {
                if (files.length >= MAX_FILES) throw Error('技能文件超过 1000 个');
                const content = await request(remote, true); bytes += content.length; files.push({ path: relative, bytes: content });
            } else throw Error('技能目录包含不支持的链接、子模块或超大文件');
        }
    }
    await walk(source.folder);
    return { package: skillPackage(files), source: source.url };
}
module.exports = { githubSource, githubPackage };
