const fs = require('node:fs/promises');
const path = require('node:path');

/** Read only the explicitly requested local media; no URL fetching or directory scanning. */
async function prepareMediaImport(args) {
    if (args.action !== 'import' || args.path === undefined) return args;
    if (typeof args.path !== 'string' || !path.isAbsolute(args.path) || args.path.startsWith('\\\\') || args.data !== undefined) throw Error('媒体导入需要一个本机绝对文件路径');
    const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm' }[path.extname(args.path).toLowerCase()];
    if (!mime) throw Error('仅支持 PNG、JPEG、WebP、MP4、WebM');
    const file = await fs.open(args.path, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || !stat.size || stat.size > 512 * 1024 * 1024) throw Error('媒体必须是 512 MB 以内的普通文件');
        const bytes = await file.readFile();
        if (bytes.length > 512 * 1024 * 1024) throw Error('媒体文件在读取期间超出大小限制');
        const { path: _path, ...rest } = args;
        return { ...rest, name: path.basename(args.path), mime, data: `data:${mime};base64,${bytes.toString('base64')}` };
    } finally { await file.close(); }
}
module.exports = { prepareMediaImport };
