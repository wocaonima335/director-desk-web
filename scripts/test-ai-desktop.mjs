import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';

await fs.mkdir('tmp', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('tmp/ai-desktop-test-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const promptFixture = '视频参考固定头：参考本场视频（待上传）\n视频固定头：16:9 电影\ncut1:\n[0—3 秒]\n人物坐下。';
let modelRequests = 0, slow = false, forgeSceneWrite = false, malformedReturned = false;
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ id: 'mock-flash', max_input_tokens: 1000000, max_tokens: 131072 })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); modelRequests++;
    if (slow) return;
    assert.equal(body.model, 'mock-flash'); assert.equal(body.max_tokens, 131072); assert.equal(req.headers.authorization, 'Bearer mock-credential');
    const replies = body.messages.filter(m => m.role === 'tool');
    const mutate = body.tools?.some(t => t.function.name === 'director_apply');
    assert.ok(!body.messages[0].content.includes('node scripts/project-tool.mjs'), 'internal AI receives the online workflow, not offline CLI steps');
    assert.ok(body.messages.some(m => typeof m.content === 'string' && m.content.includes('视频参考固定头')), 'internal AI receives the shared scene prompt format');
    if (mutate && replies.length === 1 && !malformedReturned) {
        malformedReturned = true;
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
            { id: 'malformed', function: { name: 'director_apply', arguments: '{' } },
        ] } }] })); return;
    }
    let tool;
    if (!mutate) {
        assert.deepEqual(body.tools.find(t => t.function.name === 'director_scene').function.parameters.properties.action.enum, ['list', 'read']);
        assert.ok(body.tools.some(t => t.function.name === 'director_continuity'));
    }
    if (forgeSceneWrite) tool = { name: 'director_scene', arguments: JSON.stringify({ action: 'remove', sceneId: 'scene-main', revision: 1, requestId: 'forged-discuss-write' }) };
    else if (!replies.length) tool = { name: mutate ? 'director_read' : 'director_scene', arguments: mutate ? '{"sections":["production"]}' : '{"action":"list"}' };
    else if (replies.length === 1 && mutate) tool = { name: 'director_apply', arguments: JSON.stringify({
        revision: JSON.parse(replies[0].content).data.revision, requestId: 'mock-ai-add', operations: [{ operation: 'add', asset: 'woman', id: 'ai-added', name: 'AI 演员', position: [1, 0, 2] },
            { operation: 'notes', value: { ...JSON.parse(replies[0].content).data.production, promptText: promptFixture + '\n新增人物进入。' } }] }) };
    const message = { role: 'assistant', content: tool ? null : '完成了场景检查。', ...(tool ? { tool_calls: [{ id: 'mock-call-' + replies.length, type: 'function', function: tool }] } : {}) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 } }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('.audit/desktop-app'), `--director-test-profile=${directory}`], env });
const page = await application.firstWindow(), errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => void d.accept().catch(() => {}));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const client = new Client({ name: 'director-validation', version: '1.0.0' });
try {
    await page.waitForSelector('#ai-toggle'); await page.locator('#ai-toggle').click();
    await application.evaluate(({ session, dialog }, directory) => {
        dialog.showMessageBoxSync = () => 1;
        globalThis.aiDownloads = [];
        session.defaultSession.on('will-download', (_event, item) => {
            const file = directory + '/' + item.getFilename().replaceAll('\\', '/').split('/').at(-1);
            item.setSavePath(file); item.on('done', (_e, state) => globalThis.aiDownloads.push({ file, state }));
        });
    }, directory);
    await page.locator('#ai-mcp-toggle').click();
    await page.locator('#ai-mcp-enabled').check();
    await page.waitForFunction(() => document.querySelector('#ai-mcp-status').textContent.includes('/mcp'));
    await page.locator('#ai-mcp-copy').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('配置已复制'));
    const config = JSON.parse(await application.evaluate(({ clipboard }) => clipboard.readText())).mcpServers['director-desk'];
    assert.equal((await fetch(config.url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(config.url, { method: 'POST', headers: { ...config.headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const listedTools = (await client.listTools()).tools;
    assert.ok(listedTools.find(t => t.name === 'director_apply').description.includes('director_help'), 'MCP exposes concise discovery with on-demand advanced documentation');
    const listed = listedTools.map(t => t.name).sort();
    const expectedTools = createRequire(import.meta.url)(path.resolve('.audit/desktop-app/desktop/tools-contract.cjs')).TOOL_DEFINITIONS.map(t => t.name).sort();
    assert.deepEqual(listed, expectedTools);
    const fullHelp = await client.callTool({ name: 'director_help', arguments: { names: ['director_apply'] } });
    const fullHelpData = JSON.parse(fullHelp.content[0].text);
    assert.equal(fullHelpData.ok, true);
    assert.ok(fullHelpData.data.tools[0].description.includes('retarget.footPlant'));
    for (const name of ['director_scene', 'director_continuity', 'director_nodes', 'director_motions', 'director_path_surface']) assert.ok(listed.includes(name));
    async function tool(name, args = {}, expected = true) {
        const response = await client.callTool({ name, arguments: args }), result = JSON.parse(response.content[0].text);
        assert.equal(result.ok, expected, JSON.stringify(result)); return result;
    }
    let scene = (await tool('director_read', { sections: ['all'], details: true })).data;
    const embeddedSkill = (await tool('director_skill')).data;
    assert.ok(embeddedSkill.instructions); assert.equal(embeddedSkill.unchanged, false);
    assert.equal(scene.skill.version, embeddedSkill.version);
    const learned=(await tool('director_skill', { knownVersion: embeddedSkill.version })).data;assert.equal(learned.unchanged,true);assert.equal(learned.version,embeddedSkill.version);assert.equal(learned.instructions,undefined);
    assert.equal((await tool('director_skill', { knownVersion: 'previous-version' })).data.instructions, embeddedSkill.instructions);
    const target = scene.entities.find(e => e.kind === 'actor').id;
    // Local media crosses real MCP -> desktop filesystem -> renderer -> shared transaction.
    const png=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,16,16);return c.toDataURL();});
    const mediaFile=path.join(directory,'mcp-media.png');await fs.writeFile(mediaFile,Buffer.from(png.split(',')[1],'base64'));
    const mediaArgs={action:'import',path:mediaFile,entityId:target,revision:scene.revision,requestId:'mcp-media-import'};
    const importedMedia=(await tool('director_media',mediaArgs)).data;
    assert.equal((await tool('director_media',mediaArgs)).data.revision,importedMedia.revision);
    const listedMedia=(await tool('director_media',{action:'list'})).data;assert.equal(listedMedia.media.length,1);assert.equal(listedMedia.media[0].data,undefined);
    assert.ok((await tool('director_media',{action:'surfaces',entityId:target})).data.surfaces.length>0);
    await tool('director_history',{revision:importedMedia.revision,action:'undo'});scene=(await tool('director_read',{sections:['all'],details:true})).data;
    const spatialArgs = { time: 2, cameraId: 'program', occlusionKeys: ['entity:' + target] };
    const allSpatial = (await tool('director_spatial', spatialArgs)).data;
    const selectedSpatial = (await tool('director_spatial', { ...spatialArgs, ids: [target] })).data;
    assert.deepEqual(selectedSpatial.objects, allSpatial.objects.filter(o => o.entityId === target), 'response filtering preserves full-scene occlusion results');
    assert.deepEqual(selectedSpatial.counts, allSpatial.counts);
    assert.equal((await tool('director_spatial', { ...spatialArgs, ids: [] })).data.objects.length, 0);
    console.log('Spatial response bytes:', Buffer.byteLength(JSON.stringify(allSpatial)), '->', Buffer.byteLength(JSON.stringify(selectedSpatial)));
    const catalog = (await tool('director_assets', { ids: ['person', 'furniture-desk', 'furniture-lectern', 'furniture-blackboard'], details: true })).data;
    for (const asset of catalog.assets.filter(a => a.id.startsWith('furniture-'))) assert.equal(asset.parameterPatchField, 'assetParameters');
    assert.ok((await tool('director_motions', { query: 'basic-sit' })).data.presets.some(p => p.id === 'basic-sit'));
    const classroomOps = [
        { operation: 'add', asset: 'person', id: 'review-person', patch: { path: { smooth: false, points: [{ time: 0, position: [0, 0, 0] }, { time: 3, position: [1, 0, 0] }] } } },
        { operation: 'add', asset: 'furniture-desk', id: 'review-desk', patch: { assetParameters: { width: 1.4, height: .75, depth: .7 } } },
        { operation: 'add', asset: 'furniture-lectern', id: 'review-lectern', patch: { assetParameters: { height: 1.2 } } },
        { operation: 'add', asset: 'furniture-blackboard', id: 'review-board', patch: { assetParameters: { width: 2.2 } } },
        { operation: 'add', asset: 'camera', id: 'review-camera' },
        { operation: 'motion', id: 'review-person', asset: 'basic-sit', time: 0 },
        { operation: 'notes', value: { fixedPrompt: '', sceneReferenceIds: [], promptText: promptFixture, notes: [{ id: 'review-note', actorId: 'review-person', start: 0, end: 3, story: 'A character sits', emotion: '', dialogue: '', action: 'Sit' }] } },
    ];
    const wrongField = await tool('director_apply', { revision: scene.revision, requestId: 'review-wrong-field', preview: true, operations: [{ operation: 'add', asset: 'furniture-desk', patch: { parameters: { width: 1.4 } } }] }, false);
    assert.match(wrongField.error, /operations\[0\].*patch.assetParameters/);
    const dryRun = (await tool('director_apply', { revision: scene.revision, requestId: 'review-dry-run', preview: true, operations: classroomOps })).data;
    assert.equal(dryRun.preview, true); assert.equal(dryRun.committed, false); assert.equal(dryRun.revision, scene.revision);
    assert.equal((await tool('director_read')).data.entities.some(e => e.id === 'review-person'), false);
    assert.ok(dryRun.previewId);
    const previewCommit = { revision: scene.revision, requestId: 'review-commit', previewId: dryRun.previewId };
    const committed = (await tool('director_apply', previewCommit)).data;
    assert.deepEqual((await tool('director_apply', previewCommit)).data, committed, 'preview commit retry is idempotent');
    const expired = await tool('director_apply', { revision: committed.revision, requestId: 'expired-preview', previewId: dryRun.previewId }, false);
    assert.match(expired.error, /预检已失效/);
    const commitBytes = Buffer.byteLength(JSON.stringify(previewCommit)), fullBytes = Buffer.byteLength(JSON.stringify({ revision: scene.revision, requestId: 'review-commit', operations: classroomOps }));
    await fs.writeFile('tmp/ai-preview-payload.json', JSON.stringify({ fullBytes, commitBytes, reduction: 1 - commitBytes / fullBytes }, null, 2));
    assert.equal(committed.committed, true); assert.equal(committed.summary.hasChanges, true);
    const classroom = (await tool('director_read', { ids: ['review-person', 'review-desk'], sections: ['entities', 'production'], details: true })).data;
    assert.equal(classroom.entities.find(e => e.id === 'review-desk').assetParameters.width, 1.4);
    assert.ok(classroom.entities.find(e => e.id === 'review-person').clips.some(c => c.action === 'sit'));
    assert.equal(classroom.production.notes[0].id, 'review-note');
    assert.equal(classroom.production.promptText, promptFixture);
    const identity = (await tool('director_read', { ids: ['review-person'] })).data.entities[0];
    assert.equal(identity.color, classroom.entities.find(e => e.id === identity.id).color);
    assert.equal(identity.reference, classroom.entities.find(e => e.id === identity.id).reference);
    await page.locator('#ai-close').click();
    await page.locator('#scene-prompt-toggle').click();
    assert.equal(await page.locator('#production-prompt-text').inputValue(), promptFixture);
    await page.locator('[data-act="production-copy-prompt"]').click();
    await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已复制提示词。'));
    assert.ok((await application.evaluate(({ clipboard }) => clipboard.readText())) === promptFixture, 'native clipboard receives the complete prompt');
    const promptLayout = await page.locator('.production-modal').evaluate(modal => {
        const box = modal.getBoundingClientRect();
        return [...modal.querySelectorAll('button,textarea')].every(e => {
            const rect = e.getBoundingClientRect();
            return rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom;
        });
    });
    assert.equal(promptLayout, true, 'prompt controls stay inside the dialog');
    await page.keyboard.press('Escape'); await page.locator('#ai-toggle').click();
    const wrongNotes = await tool('director_apply', { revision: classroom.revision, requestId: 'review-notes-patch', preview: true, operations: [{ operation: 'notes', patch: { story: 'wrong field' } }] }, false);
    assert.match(wrongNotes.error, /operations\[0\].*fixedPrompt/);
    assert.deepEqual((await tool('director_read', { sections: ['production'] })).data.production, classroom.production);
    const alternatives = (await tool('director_assets', { queries: ['blackboard', 'lectern', 'desk'] })).data.assets;
    assert.ok(['furniture-blackboard', 'furniture-lectern', 'furniture-desk'].every(id => alternatives.some(a => a.id === id)));
    await tool('director_path_surface', { entityId: 'review-person' });
    // These require an imported model / retarget clip; basic props or basic sit must fail explicitly.
    await tool('director_nodes', { entityId: 'review-desk' }, false);
    await tool('director_stride', { entityId: 'review-person', clipId: classroom.entities.find(e => e.id === 'review-person').clips[0].id }, false);
    await tool('director_history', { action: 'undo', revision: committed.revision });
    scene = (await tool('director_read', { sections: ['all'], details: true })).data;
    assert.equal(scene.entities.some(e => e.id.startsWith('review-')), false);
    const initial = scene.entities.length;
    const batch = { revision: scene.revision, requestId: 'mcp-add', operations: [{ operation: 'add', asset: 'woman', id: 'mcp-actor', name: 'MCP 演员', patch: { path: { smooth: false, points: [{ time: 0, position: [0, 0, 0] }, { time: 5, position: [2, 1, 3] }] }, clips: [{ id: 'mcp-walk', action: 'walk', start: 0, end: 5, speed: 1 }] } }] };
    const first = await tool('director_apply', batch); assert.deepEqual(await tool('director_apply', batch), first);
    scene = (await tool('director_read', { sections: ['all'], details: true })).data; assert.equal(scene.entities.length, initial + 1);
    await tool('director_apply', { ...batch, requestId: 'stale' }, false);
    const bad = await tool('director_export', { kind: 'video', size: 8000 }, false); assert.match(bad.error, /参数/);
    await tool('director_apply', { revision: scene.revision, requestId: 'rollback', operations: [{ operation: 'add', asset: 'woman' }, { operation: 'update', id: 'missing', patch: { name: 'x' } }] }, false);
    assert.equal((await tool('director_read')).data.entities.length, initial + 1);
    await tool('director_spatial', { time: 2, cameraId: 'program', occlusionKeys: ['entity:mcp-actor'] });
    const scan = (await tool('director_scan', { start: 0, end: 1, sampleFps: 2, targetKey: 'entity:mcp-actor', cameraId: 'program', occlusion: true })).data;
    let job; for (let i = 0; i < 100; i++) { job = (await tool('director_job', { id: scan.jobId })).data; if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(job.status, 'completed');
    const exported = (await tool('director_export', { kind: 'video', start: 0, end: 0.5, size: 1920 })).data;
    for (let i = 0; i < 300; i++) { job = (await tool('director_job', { id: exported.jobId })).data; if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(job.status, 'completed');
    let saved; for (let i = 0; i < 100; i++) { saved = (await application.evaluate(() => globalThis.aiDownloads))[0]; if (saved) break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(saved.state, 'completed');
    const video = new Input({ source: new BufferSource(new Uint8Array(await fs.readFile(saved.file))), formats: ALL_FORMATS }), track = await video.getPrimaryVideoTrack();
    assert.equal(track.displayWidth, 1920); assert.equal(track.displayHeight, 1080);
    let frames = 0; for await (const _packet of new EncodedPacketSink(track).packets()) frames++; assert.equal(frames, 12); video.dispose();
    await tool('director_history', { revision: scene.revision, action: 'undo' }); assert.equal((await tool('director_read')).data.entities.length, initial);
    // Real MCP transport must preserve independent scene history and inherited state.
    const beforeContinuation = (await tool('director_read', { sections: ['production'] })).data;
    await tool('director_apply', { revision: beforeContinuation.revision, requestId: 'source-prompt', operations: [
        { operation: 'notes', value: { ...beforeContinuation.production, fixedPrompt: '电影风格', promptText: promptFixture } },
    ] });
    const originalScene = (await tool('director_scene', { action: 'read' })).data;
    await page.locator('#ai-chat-toggle').click();
    await page.locator('#ai-scene-prompt').click();
    assert.equal(await page.locator('#production-prompt-text').inputValue(), promptFixture);
    const continueArgs = { action: 'continue', name: '接拍验证', newSceneId: 'mcp-scene-b', revision: originalScene.revision, requestId: 'mcp-continue' };
    const continued = await tool('director_scene', continueArgs); assert.deepEqual(await tool('director_scene', continueArgs), continued);
    const ending = (await tool('director_continuity', { limit: 1 })).data;
    assert.equal(ending.origin.sourceStatus, 'unchanged'); assert.equal(ending.origin.objects.length, 1);
    assert.equal(ending.origin.nextOffset, 1);
    const second = (await tool('director_read', { sections: ['production'] })).data;
    assert.equal(second.production.promptText, undefined, 'a continuation does not replay the preceding scene prompt');
    assert.equal(second.production.fixedPrompt, '电影风格');
    assert.equal(second.sceneContext.sceneId, 'mcp-scene-b');
    await page.locator('#production-prompt-text').fill('旧窗口编辑不应写到新段');
    await page.locator('#production-prompt-text').blur();
    assert.equal((await tool('director_read', { sections: ['production'] })).data.production.promptText, undefined);
    await page.keyboard.press('Escape');
    await page.locator('#ai-scene-prompt').click();
    assert.equal(await page.locator('#production-prompt-text').inputValue(), '');
    assert.equal(await page.locator('.modal-header h2').textContent(), '接拍验证 · 视频提示词');
    await page.keyboard.press('Escape');
    await tool('director_apply', { revision: originalScene.revision, requestId: 'mcp-before-switch', operations: [{ operation: 'add', asset: 'woman' }] }, false);
    await tool('director_apply', { revision: second.revision, requestId: 'mcp-edit-b', operations: [{ operation: 'add', asset: 'woman', id: 'b-only' }] });
    const rereadOriginal = (await tool('director_scene', { action: 'read', sceneId: originalScene.sceneId })).data;
    assert.equal(rereadOriginal.active, false);
    const { revision: _old, active: _wasActive, ...originalData } = originalScene, { revision: _new, active: _nowActive, ...rereadData } = rereadOriginal;
    assert.deepEqual(rereadData, originalData);
    await tool('director_history', { revision: (await tool('director_read')).data.revision, action: 'undo' });
    await tool('director_history', { revision: (await tool('director_read')).data.revision, action: 'undo' });
    assert.equal((await tool('director_scene', { action: 'list' })).data.scenes.length, 1);
    // Configure through the real UI, without any paid external request.
    await page.locator('#ai-close').click();
    const rightBoundary = page.locator('[data-boundary="inspector"]');
    const rightWidth = Number(await rightBoundary.getAttribute('aria-valuenow'));
    await rightBoundary.focus(); await rightBoundary.press('ArrowLeft');
    assert.equal(Number(await rightBoundary.getAttribute('aria-valuenow')), rightWidth + 10, 'left arrow moves the right divider left');
    await rightBoundary.press('ArrowRight');
    assert.equal(Number(await rightBoundary.getAttribute('aria-valuenow')), rightWidth);
    await tool('director_view', { time: 0, cameraId: 'program' });
    await page.locator('.playback-buttons [data-act="play"]').click();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok((await tool('director_read', { ids: [] })).data.time > 0, 'playback advances time');
    await page.locator('.playback-buttons [data-act="play"]').click();
    await tool('director_view', { time: 0, cameraId: 'program' });
    await page.locator('#ai-toggle').click();
    await page.locator('#ai-settings-toggle').click(); await page.locator('#ai-name').fill('本地验证');
    assert.equal(await page.locator('#ai-flash').count(), 0);
    assert.equal(await page.locator('#ai-max-tokens').inputValue(), '0');
    assert.equal(await page.locator('#ai-max-rounds').inputValue(), '64');
    assert.equal(await page.locator('#ai-max-tokens').getAttribute('max'), null);
    assert.equal(await page.locator('#ai-max-rounds').getAttribute('max'), null);
    await page.locator('#ai-url').fill(`http://127.0.0.1:${server.address().port}/v1`); await page.locator('#ai-model').fill('mock-flash');
    await page.locator('#ai-key').fill('mock-credential'); await page.locator('#ai-stream').uncheck();
    await page.locator('#ai-settings button[type=submit]').click(); await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('渠道已保存'));
    const stored = await fs.readFile(path.join(directory, 'ai-channels.json'), 'utf8'); assert.ok(!stored.includes('mock-credential'));
    const publicData = await page.evaluate(() => window.directorDesktop.profiles()); assert.ok(!JSON.stringify(publicData).includes('mock-credential'));
    await page.screenshot({ path: 'tmp/ai-settings-validation.png' });
    const overflow = await page.evaluate(() => { const p = document.querySelector('#ai-panel'), rect = p.getBoundingClientRect(); return { scroll: p.scrollHeight > p.clientHeight + 2, bottom: Math.max(...[...p.querySelectorAll('input,select,button,textarea')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().bottom)) > rect.bottom }; });
    assert.deepEqual(overflow, { scroll: false, bottom: false });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.waitForTimeout(150);
    const layoutChecks = [];
    async function checkPanel(view) {
        const viewportClass = await page.locator('#viewports').getAttribute('class');
        await page.locator(`#ai-${view === 'settings' ? 'settings' : view}-toggle`).click();
        await page.locator('.ai-header strong').click();
        assert.equal(await page.locator('#viewports').getAttribute('class'), viewportClass, 'assistant controls must not switch the staging viewport');
        const issues = await page.evaluate(() => {
            const panel = document.querySelector('#ai-panel'), b = panel.getBoundingClientRect();
            const issues = [];
            for (const e of panel.querySelectorAll('input,select,button,textarea,.ai-view,.ai-settings-fields')) {
                if (!e.getClientRects().length) continue;
                const r = e.getBoundingClientRect();
                if (r.left < b.left || r.right > b.right || r.top < b.top || r.bottom > b.bottom) issues.push(e.id || e.className);
                if (e.matches('.ai-view,.ai-settings-fields') && (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2)) issues.push('scroll:' + e.id);
            }
            if (panel.scrollHeight > panel.clientHeight + 2 || panel.scrollWidth > panel.clientWidth + 2) issues.push('panel-scroll');
            return issues;
        });
        assert.deepEqual(issues, [], view); layoutChecks.push(view);
    }
    await page.locator('#ai-name').fill('尚未保存的草稿');
    await page.locator('#ai-chat-toggle').click(); await page.locator('#ai-prompt').fill('未发送任务');
    for (const view of ['chat', 'settings', 'mcp']) await checkPanel(view);
    const grip = page.locator('#ai-resize'), box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x - 150, box.y); await page.mouse.up();
    assert.equal(Math.round((await page.locator('#ai-panel').boundingBox()).width), 340);
    for (const view of ['chat', 'settings', 'mcp']) await checkPanel(view);
    await page.locator('#ai-settings-toggle').click();
    assert.equal(await page.locator('#ai-name').inputValue(), '尚未保存的草稿');
    await page.locator('#ai-name').fill('本地验证');
    await page.screenshot({ path: 'tmp/ai-settings-small.png' });
    // Focused inputs can close the panel; reopening preserves the current form.
    await page.locator('#ai-name').press('Escape'); assert.equal(await page.locator('#ai-panel').isVisible(), false);
    await page.locator('#ai-toggle').click(); assert.equal(await page.locator('#ai-settings').isVisible(), true);
    await grip.focus(); await grip.press('Home');
    assert.equal(Math.round((await page.locator('#ai-panel').boundingBox()).width), 400);
    const freshBox = await grip.boundingBox();
    await page.mouse.move(freshBox.x + freshBox.width / 2, freshBox.y + freshBox.height / 2); await page.mouse.down(); await page.mouse.move(550, freshBox.y);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.move(520, freshBox.y); await page.mouse.up();
    assert.equal(Math.round((await page.locator('#ai-panel').boundingBox()).width), 400);
    await page.locator('#ai-collapse').click();
    assert.equal(await page.locator('#ai-collapse').getAttribute('aria-expanded'), 'false');
    assert.equal(Math.round((await page.locator('#ai-panel').boundingBox()).height), 58);
    const header = await page.locator('.ai-header').boundingBox(), collapsed = await page.locator('#ai-panel').boundingBox();
    await page.mouse.move(header.x + 40, header.y + 10); await page.mouse.down(); await page.mouse.move(header.x - 60, header.y - 20); await page.mouse.up();
    assert.ok((await page.locator('#ai-panel').boundingBox()).x < collapsed.x - 50);
    await page.locator('#ai-collapse').click();
    assert.equal(await page.locator('#ai-settings').isVisible(), true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.locator('#ai-chat-toggle').click(); assert.equal(await page.locator('#ai-prompt').inputValue(), '未发送任务');
    await page.locator('#ai-prompt').fill('添加一个演员'); await page.locator('#ai-send').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('任务完成'));
    assert.ok((await tool('director_read')).data.entities.some(e => e.id === 'ai-added'));
    assert.equal((await tool('director_read', { sections: ['production'] })).data.production.promptText, promptFixture + '\n新增人物进入。');
    assert.equal((await tool('director_scene', { action: 'list' })).data.scenes.length, 1, 'ordinary AI edit stays in the current scene');
    await page.locator('#ai-undo').click(); assert.equal((await tool('director_read')).data.entities.length, initial);
    const beforeNewChat = (await tool('director_scene', { action: 'read' })).data;
    await page.locator('#ai-new').click();
    assert.deepEqual((await tool('director_scene', { action: 'read' })).data, beforeNewChat, 'new conversation does not create or clear the project');
    await page.locator('#ai-mode').selectOption('discuss'); await page.locator('#ai-prompt').fill('讨论'); await page.locator('#ai-prompt').press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('任务完成'));
    assert.equal((await tool('director_read')).data.entities.length, initial);
    forgeSceneWrite = true;
    await page.locator('#ai-new').click(); await page.locator('#ai-prompt').fill('讨论越权检查'); await page.locator('#ai-send').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('不允许'));
    assert.equal((await tool('director_scene', { action: 'list' })).data.scenes.length, 1);
    assert.equal((await tool('director_read')).data.entities.length, initial);
    forgeSceneWrite = false;
    slow = true; const before = modelRequests; await page.locator('#ai-prompt').fill('停止测试'); await page.locator('#ai-send').click();
    for (let i = 0; i < 100 && modelRequests === before; i++) await new Promise(r => setTimeout(r, 20));
    const sessionBeforeFold = (await page.evaluate(() => window.directorDesktop.conversation())).data.sessionId;
    await page.locator('#ai-collapse').click();
    assert.equal(await page.locator('#ai-panel').getAttribute('data-running'), 'true');
    assert.equal((await page.evaluate(() => window.directorDesktop.conversation())).data.sessionId, sessionBeforeFold);
    await page.locator('#ai-collapse').click();
    await page.locator('#ai-mcp-toggle').click();
    await page.locator('#ai-background-stop').click(); await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('已停止'));
    assert.equal(modelRequests, before + 1);
    assert.equal(await page.locator('#ai-background-stop').isVisible(), false);
    await page.locator('#ai-chat-toggle').click();
    const retainedConversation = (await page.evaluate(() => window.directorDesktop.conversation())).data;
    assert.match(retainedConversation.transcript, /讨论越权检查/); assert.match(retainedConversation.transcript, /停止测试/);
    const switchProfile = (await page.evaluate(() => window.directorDesktop.configure({ name: '对话切换检查', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'anthropic', model: 'mock', maxTokens: 1000, maxRounds: 1, stream: false }))).data.at(-1);
    await page.locator('#ai-channel').evaluate((el, p) => { el.add(new Option(p.name, p.id)); el.value = p.id; el.dispatchEvent(new Event('change')); }, switchProfile);
    assert.equal((await page.evaluate(() => window.directorDesktop.conversation())).data.sessionId, retainedConversation.sessionId);
    assert.match(await page.locator('#ai-transcript').inputValue(), /讨论越权检查/);
    await page.screenshot({ path: 'tmp/ai-execution-validation.png' });
    // Lock must be respected across MCP as well as in-app edits.
    scene = (await tool('director_read', { sections: ['all'], details: true })).data;
    await tool('director_view', { time: 0, entityId: scene.entities.find(e => e.kind === 'actor').id });
    await page.locator('#ai-close').click();
    // Memory-only secret disappears on process reload of the host; remembered secret is encrypted on disk.
    const currentProfile = (await page.evaluate(() => window.directorDesktop.profiles())).data[0];
    const remembered = await page.evaluate(p => window.directorDesktop.configure({ ...p, remember: true }), currentProfile);
    assert.equal(remembered.ok, true); assert.equal(remembered.data.find(p => p.id === currentProfile.id).remembered, true);
    const protectedFile = JSON.parse(await fs.readFile(path.join(directory, 'ai-channels.json'), 'utf8'));
    assert.ok(protectedFile.profiles.find(p => p.id === currentProfile.id).encryptedKey); assert.ok(!JSON.stringify(protectedFile).includes('mock-credential'));
    await page.reload(); await page.waitForSelector('#ai-toggle');
    await page.waitForFunction(() => document.querySelector('#ai-transcript').value.includes('停止测试'));
    assert.equal((await page.evaluate(() => window.directorDesktop.conversation())).data.sessionId, retainedConversation.sessionId);
    await page.locator('#ai-toggle').click(); await page.locator('#ai-new').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('手动开始新对话'));
    assert.equal(await page.locator('#ai-transcript').inputValue(), '');
    assert.notEqual((await page.evaluate(() => window.directorDesktop.conversation())).data.sessionId, retainedConversation.sessionId);
    assert.equal((await tool('director_read')).ok, true);
    const obsolete = await tool('director_apply', { revision: scene.revision, requestId: 'pre-reload', operations: [{ operation: 'add', asset: 'woman' }] }, false);
    assert.match(obsolete.error, /REVISION_CONFLICT/);
    assert.deepEqual(errors, []);
    assert.equal(malformedReturned, true);
    await fs.writeFile('tmp/ai-validation.json', JSON.stringify({ pass: true, mcp: ['auth', 'origin', 'list', 'atomic', 'idempotency', 'revision', 'undo', 'spatial', 'scan', 'scene continuation', 'scene isolation', 'continuity pagination', 'catalog patch routes', 'preview and commit', 'same-batch sit', 'path surfaces', 'nodes/stride unsupported-target rejection'], ai: ['UI config', 'memory secret', 'tool loop', 'undo', 'discuss', 'forged scene mutation rejected', 'invalid JSON regenerated', 'shared online workflow', 'stop'], layoutChecks, modelRequests, externalRequests: 0, errors }, null, 2));
    console.log('AI/MCP desktop validation passed: authenticated real MCP, shared scene transactions, local provider tool loop, undo, discuss, stop, and private configuration.');
} catch (e) { await page.screenshot({ path: 'tmp/ai-desktop-failure.png' }).catch(() => {}); console.log('Desktop AI validation failed:', e.message, errors); throw e; }
finally {
    await client.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r));
    await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners('window-all-closed'); BrowserWindow.getAllWindows().forEach(w => w.destroy()); }).catch(() => {});
    await application.close().catch(() => {});
}
