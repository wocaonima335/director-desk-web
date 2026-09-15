import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

await fs.mkdir('tmp', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('tmp/ai-restart-test-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const server = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end('Local restart test failure'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let application;
async function launch() {
    application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('.audit/desktop-app'), `--director-test-profile=${directory}`], env });
    const page = await application.firstWindow(); await page.waitForSelector('#ai-toggle');
    await page.waitForFunction(() => Boolean(window.directorDesktop));
    return page;
}
async function close() {
    if (!application) return;
    await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners('window-all-closed'); BrowserWindow.getAllWindows().forEach(w => w.destroy()); }).catch(() => {});
    await application.close(); application = undefined;
}
try {
    let page = await launch();
    assert.equal((await page.evaluate(() => window.directorDesktop.mcp(true))).ok, true);
    await page.evaluate(() => window.directorDesktop.copyMcp());
    const originalMcp = await application.evaluate(({ clipboard }) => clipboard.readText());
    const storedMcp = await fs.readFile(path.join(directory, 'mcp-connection.json'), 'utf8');
    assert.ok(!storedMcp.includes(JSON.parse(originalMcp).mcpServers['director-desk'].headers.Authorization.slice(7)), 'MCP token is encrypted on disk');
    const configured = await page.evaluate(baseUrl => window.directorDesktop.configure({ name: '重启检查', protocol: 'chat', baseUrl, model: 'mock', maxTokens: 1000, maxRounds: 1, stream: false }), `http://127.0.0.1:${server.address().port}/v1`);
    assert.equal(configured.ok, true);
    const task = await page.evaluate(profileId => window.directorDesktop.run({ profileId, prompt: '重启以后继续保持蓝衣主角', mode: 'execute' }), configured.data[0].id);
    assert.equal(task.ok, true); assert.equal(task.data.stopped, true);
    const previous = (await page.evaluate(() => window.directorDesktop.conversation())).data;
    assert.match(previous.transcript, /蓝衣主角/); assert.match(previous.transcript, /对话已保留/);
    const disk = await fs.readFile(path.join(directory, 'ai-conversation.json'), 'utf8');
    assert.equal(JSON.parse(disk).encrypted, true, 'Windows conversation is encrypted with actual Electron safeStorage');
    assert.ok(!disk.includes('蓝衣主角'));
    await close();
    page = await launch();
    await page.locator('#ai-toggle').click(); await page.locator('#ai-mcp-toggle').click();
    await page.locator('#ai-mcp-enabled').check();
    await page.waitForFunction(() => document.querySelector('#ai-mcp-status').textContent.includes('/mcp'));
    await page.evaluate(() => window.directorDesktop.copyMcp());
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), originalMcp, 'MCP configuration survives an actual Electron restart');
    page.once('dialog', d => void d.dismiss()); await page.locator('#ai-mcp-reset').click();
    await page.evaluate(() => window.directorDesktop.copyMcp());
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), originalMcp, 'Cancel preserves credentials');
    page.once('dialog', d => void d.accept()); await page.locator('#ai-mcp-reset').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('访问令牌已重置'));
    await page.evaluate(() => window.directorDesktop.copyMcp());
    const newMcp = JSON.parse(await application.evaluate(({ clipboard }) => clipboard.readText())).mcpServers['director-desk'];
    const oldMcp = JSON.parse(originalMcp).mcpServers['director-desk'];
    assert.equal(newMcp.url, oldMcp.url); assert.notDeepEqual(newMcp.headers, oldMcp.headers);
    assert.equal((await fetch(oldMcp.url, { method: 'POST', headers: oldMcp.headers, body: '{}' })).status, 403);
    await page.locator('#ai-chat-toggle').click(); await page.locator('#ai-toggle').click();
    await page.waitForFunction(() => document.querySelector('#ai-transcript').value.includes('蓝衣主角'));
    assert.deepEqual((await page.evaluate(() => window.directorDesktop.conversation())).data, previous);
    await page.locator('#ai-toggle').click(); await page.locator('#ai-new').click();
    await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('手动开始新对话'));
    const cleared = (await page.evaluate(() => window.directorDesktop.conversation())).data;
    assert.notEqual(cleared.sessionId, previous.sessionId); assert.equal(cleared.transcript, '');
    console.log('Conversation and encrypted MCP credentials survive actual Electron restart; explicit credential reset revokes old access. External requests: 0.');
} finally { await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
