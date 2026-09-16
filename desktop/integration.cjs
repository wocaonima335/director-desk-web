const { prepareMediaImport } = require('./media-import.cjs');
const { ipcMain, app, safeStorage, clipboard, dialog } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createAIHost } = require('./ai-host.cjs');
const { createMcpHost } = require('./mcp-host.cjs');
const { releaseVersion } = require('./release-version.cjs');
const { createSkillStore } = require('./skills/store.cjs');
const { createSkillHost } = require('./skills/host.cjs');
const { TOOL_DEFINITIONS, MCP_TOOL_DEFINITIONS, DISCUSSION_TOOLS, isDiscussionToolCall, BUILTIN_SKILL } = require('./tools-contract.cjs');
// DSK-003/004: pure shared contract (bundled in by esbuild; validates payloads in the main process).
const { dispatchDskRequest, isTrustedDskFrame } = require('../shared/contracts/index.ts');
// DSK-004 storage service: sessions, leases, snapshots, backup/restore. The document verifier and
// canonical serializer are DOM-free TS modules bundled in; the Electron dialog stays injectable.
const { createStorageService, createUnavailableStorageService } = require('./storage/service.cjs');
const { assertSceneDocument } = require('../src/scenes/sequence-project.ts');
const { canonicalJson } = require('../shared/storage/canonical.ts');
const { BackupManifestSchema } = require('../shared/contracts/storage.ts');
function attachIntegration(window) {
    const pending = new Map(); let ready = false;
    const skills = createSkillStore({ directory: app.getPath('userData'), builtin: BUILTIN_SKILL });
    void skills.ready.catch(() => {});
    const trusted = event => event.sender === window.webContents && event.senderFrame?.url === 'director://app/';
    const callTool = async (name, args) => {
        if(name==='director_media'&&args?.action==='import'){try{args=await prepareMediaImport(args);}catch(error){return {ok:false,error:error.message};}}
        return name === 'director_skill'
        ? skills.tool(args).then(data => ({ ok: true, data }), error => ({ ok: false, error: error.message }))
        : new Promise(resolve => {
        if (!ready || window.isDestroyed()) return resolve({ ok: false, error: '导演台尚未连接或正在重新载入' });
        const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, execution: 'unknown', error: '工具响应超时，请先查询状态，不要直接重复写入' }); }, 60000);
        pending.set(id, { resolve, timer }); window.webContents.send('director-tool-call', { id, name, args });
    });
    };
    const mcp = createMcpHost({ directory: app.getPath('userData'), safeStorage, definitions: MCP_TOOL_DEFINITIONS, call: callTool, version: releaseVersion(app.getVersion()),
        bridgeRuntime: { command: process.execPath, bridgePath: app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'stdio-bridge.cjs') : path.join(app.getAppPath(), 'desktop', 'mcp-stdio.cjs') } });
    const host = createAIHost({ directory: app.getPath('userData'), safeStorage, definitions: TOOL_DEFINITIONS, discussionTools: DISCUSSION_TOOLS, isDiscussionToolCall, callTool,
        skill: BUILTIN_SKILL, skills,
        send: data => { if (!window.isDestroyed()) window.webContents.send('director-ai-event', data); } });
    const skillHost = createSkillHost({ store: skills, window, isRunning: () => host.isRunning() });
    const resultHandler = (event, data) => { if (!trusted(event) || !data || !pending.has(data.id)) return; const item = pending.get(data.id); clearTimeout(item.timer); pending.delete(data.id); item.resolve(data.result); };
    const readyHandler = event => { if (trusted(event)) ready = true; };
    ipcMain.on('director-tool-result', resultHandler); ipcMain.on('director-tools-ready', readyHandler);
    // DSK-004 managed project library: userData/managed in the product; isolated directory and
    // short lease overrides only for unpackaged test runs, never for packaged builds.
    // R1: an unusable library (foreign schema, damaged file) must be reportable through the dsk
    // channel, never block app startup — every action then answers with the frozen failure shape.
    let storage = null;
    const storageVerifiers = { document: assertSceneDocument, canonical: canonicalJson, manifest: BackupManifestSchema };
    const createService = root => {
        const ttlOverride = Number(process.env.DIRECTOR_STORAGE_LEASE_TTL_MS);
        return createStorageService({
            root,
            verifiers: storageVerifiers,
            dialog,
            leaseTtlMs: Number.isFinite(ttlOverride) && ttlOverride >= 1000 ? ttlOverride : 30000,
            leaseRenewMs: Number.isFinite(ttlOverride) && ttlOverride >= 1000 ? Math.max(1000, Math.floor(ttlOverride / 3)) : 10000,
        });
    };
    if (!app.isPackaged && app.commandLine.hasSwitch('director-storage-dir')) {
        try {
            storage = createService(path.resolve(app.commandLine.getSwitchValue('director-storage-dir')));
        } catch (error) {
            storage = createUnavailableStorageService(error && error.message);
        }
    } else {
        try {
            storage = createService(path.join(app.getPath('userData'), 'managed'));
        } catch (error) {
            storage = createUnavailableStorageService(error && error.message);
        }
    }
    // DSK-003 minimal restricted pipeline channel: same sender/main-frame trust policy as
    // director-host, schema-validated payload, closed action whitelist. DSK-004 wires the real
    // storage handlers; workflow/model actions still return NOT_IMPLEMENTED (DSK-007/016).
    ipcMain.handle('director-dsk', async (event, input) => {
        if (!isTrustedDskFrame(event, window)) return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '拒绝未知页面' } };
        return storage.runInRequestContext(event, () => dispatchDskRequest(input, storage.handlers));
    });
    ipcMain.handle('director-host', async (event, input) => {
        if (!trusted(event)) throw new Error('拒绝未知页面');
        try {
            const { action, data } = input || {}; let result;
            if (action === 'profiles') result = await host.list();
            else if (action === 'conversation') result = await host.conversation();
            else if (action === 'new-conversation') result = await host.newConversation();
            else if (action === 'configure') result = await host.configure(data);
            else if (action === 'run') { if (skillHost.isBusy()) throw Error('请等技能导入完成后再发送任务'); result = await host.run(data); }
            else if (action === 'skills') result = await skillHost.handle(data);
            else if (action === 'stop') { host.stop(); result = true; }
            else if (action === 'test') result = await host.test(data);
            else if (action === 'mcp') {
                result = await mcp.change(data);
            } else if (action === 'mcp-lan') {
                result = await mcp.lan(data);
            } else if (action === 'reset-mcp') {
                result = await mcp.reset();
            } else if (action === 'copy-mcp') {
                const client = typeof data === 'string' ? data : data?.client;
                const useLan = typeof data === 'object' ? Boolean(data?.useLan) : false;
                clipboard.writeText(JSON.stringify(await mcp.connection(client, { useLan }), null, 2)); result = true;
            } else if (action === 'copy-text') {
                if (typeof data !== 'string' || data.length > 100000) throw new Error('复制内容无效或超过 100000 字');
                clipboard.writeText(data); result = true;
            } else throw new Error('未知桌面操作');
            return { ok: true, data: result };
        } catch (e) { return { ok: false, error: e.message }; }
    });
    window.webContents.on('did-start-loading', () => { ready = false; host.stop(); storage.closeFrameSessions(); for (const task of pending.values()) { clearTimeout(task.timer); task.resolve({ ok: false, execution: 'unknown', error: '页面重新载入，调用结果未确认；请重新读取工程，不要直接重复写入' }); } pending.clear(); });
    window.on('closed', () => { host.stop(); void mcp.close(); storage.dispose(); for (const task of pending.values()) { clearTimeout(task.timer); task.resolve({ ok: false, execution: 'unknown', error: '软件已关闭，调用结果未确认；请重新读取工程，不要直接重复写入' }); }
        ipcMain.removeHandler('director-host'); ipcMain.removeHandler('director-dsk'); ipcMain.removeListener('director-tool-result', resultHandler); ipcMain.removeListener('director-tools-ready', readyHandler); });
    return { isBusy: () => host.isRunning() || skillHost.isBusy() || pending.size > 0 || storage.isBusy() };
}
module.exports = { attachIntegration };
