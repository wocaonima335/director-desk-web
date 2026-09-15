const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');

function connectionFromEnv(env) {
    let url;
    try { url = new URL(env.DIRECTOR_MCP_URL); } catch { throw Error('缺少有效的本机 MCP 地址，请重新复制连接配置。'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash)
        throw Error('桥接仅连接导演台复制配置中的本机回环地址。');
    if (!/^[a-f0-9]{64}$/.test(env.DIRECTOR_MCP_TOKEN || '')) throw Error('缺少有效的本机 MCP 凭据，请重新复制连接配置。');
    return { url, token: env.DIRECTOR_MCP_TOKEN };
}

async function startBridge(env = process.env, input = process.stdin, output = process.stdout) {
    const { url, token } = connectionFromEnv(env);
    const upstream = new Client({ name: 'director-desk-stdio', version: '1.0.0' });
    const http = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
        reconnectionOptions: { maxRetries: 0 },
    });
    const server = new Server({ name: 'director-desk', version: '1.0.0' }, {
        capabilities: { tools: {} }, instructions: '先按需读取 director_skill。当前对话已包含同版本说明时无需重读。工具操作运行中的导演台当前工程。',
    });
    let closed = false;
    const onEnd = () => { void close(); };
    const close = async () => {
        if (closed) return; closed = true;
        input.off('end', onEnd); output.off('error', onEnd);
        await Promise.allSettled([server.close(), upstream.close()]);
    };
    server.onclose = () => { void close(); };
    // Protocol output is exclusively JSON-RPC. Never print upstream errors that
    // could contain credentials, nor automatically replay an interrupted write.
    server.onerror = () => {};
    upstream.onerror = () => {};
    const forward = async task => {
        try { return await task(); }
        catch { throw new McpError(ErrorCode.InternalError, '导演台连接中断、凭据失效或请求失败；写入结果可能尚未确认。请检查本机 MCP 并回读工程，不要直接重复写入。'); }
    };
    server.setRequestHandler(ListToolsRequestSchema, (request, extra) => forward(() => upstream.listTools(request.params, { signal: extra.signal, timeout: 10000 })));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => forward(() => upstream.callTool(request.params, undefined, { signal: extra.signal, timeout: 75000 })));
    try {
        await upstream.connect(http, { timeout: 10000 });
        await server.connect(new StdioServerTransport(input, output));
        input.once('end', onEnd); output.once('error', onEnd);
    } catch {
        await close(); throw Error('无法连接导演台。请先打开软件并启用本机 MCP；如已重置凭据，请重新复制配置。');
    }
    return { close };
}
if (require.main === module) {
    startBridge().then(bridge => {
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close(); });
    }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = { startBridge, connectionFromEnv };
