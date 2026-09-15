import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = await fs.mkdtemp(path.resolve('tmp/mcp-client-ui-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const runtime = createRequire(import.meta.url)('electron');
const app = await electron.launch({ executablePath: runtime, args: [path.resolve('.audit/desktop-app'), `--director-test-profile=${root}`], env });
try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.application-menu');
    await page.locator('#ai-toggle').click(); await page.locator('#ai-mcp-toggle').click();
    await page.locator('#ai-mcp-enabled').check(); await page.waitForFunction(() => document.querySelector('#ai-mcp-status').textContent.includes('127.0.0.1'));
    let toolNames;
    for (const kind of ['http', 'claude-code', 'claude-desktop', 'stdio']) {
        await app.evaluate(({ clipboard }) => clipboard.clear());
        await page.locator('#ai-mcp-client').selectOption(kind); await page.locator('#ai-mcp-copy').click();
        let text = '';
        for (let i = 0; i < 50 && !text; i++) { text = await app.evaluate(({ clipboard }) => clipboard.readText()); if (!text) await page.waitForTimeout(50); }
        const config = JSON.parse(text).mcpServers['director-desk'];
        const client = new Client({ name: 'desktop-config-verification', version: '1.0.0' });
        const transport = config.command ? new StdioClientTransport({ ...config, stderr: 'pipe' }) : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
        let stderr = ''; if (transport.stderr) transport.stderr.on('data', data => { stderr += data; });
        try {
            await client.connect(transport); const tools = (await client.listTools()).tools.map(t => t.name).sort();
            assert(tools.includes('director_skill')); assert(tools.includes('director_apply'));
            if (toolNames) assert.deepEqual(tools, toolNames); toolNames = tools;
            const result = await client.callTool({ name: 'director_read', arguments: { sections: ['entities'] } });
            assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).ok, true);
            if (kind === 'claude-code') assert.equal(config.type, 'http');
            if (config.command) { assert.equal(config.command, runtime); assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1'); assert((await fs.stat(config.args[0])).isFile()); }
            console.log(`${kind}: copied UI configuration discovers the same ${tools.length} tools and reads the live test project.`);
        } finally { await client.close(); }
        assert.equal(stderr, '');
    }
    assert.equal(await page.locator('#ai-mcp-client option').first().evaluate(o => getComputedStyle(o).backgroundColor), 'rgb(36, 36, 36)');
    await page.screenshot({ path: path.join(root, 'mcp-clients.png') });
    assert.deepEqual(errors, []);
    await page.locator('#ai-mcp-enabled').uncheck();
} finally {
    await app.evaluate(({ clipboard, BrowserWindow }) => { clipboard.clear(); for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await app.close();
    // Only delete the isolated test credential/config files; retain the UI capture.
    if (path.dirname(root) !== path.resolve('tmp') || !path.basename(root).startsWith('mcp-client-ui-')) throw Error('Invalid test profile');
    for (const name of ['mcp-connection.json', 'mcp-connection.json.tmp']) await fs.rm(path.join(root, name), { force: true });
}
