const { createHash } = require('node:crypto');
const cache = new Map();
const positive = value => Number.isSafeInteger(value) && value > 0;
function outputLimit(info) {
    // Context length is deliberately NOT an output limit.
    return [info?.max_output_tokens, info?.max_tokens, info?.max_completion_tokens,
        info?.limits?.max_output_tokens, info?.top_provider?.max_completion_tokens].find(positive);
}
async function automaticOutputLimit(profile, key, signal) {
    const base = profile.baseUrl.replace(/\/(?:chat\/completions|responses|messages)$/, '');
    // Official provider profile; custom relays may impose their own limits.
    // https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/
    if (new URL(base).hostname === 'api.deepseek.com' && ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(profile.model)) return 384000;
    const id = JSON.stringify([base, profile.protocol, profile.model, createHash('sha256').update(key).digest('hex')]);
    const cached = cache.get(id); if (cached && Date.now() - cached.time < 3600000) return cached.limit;
    const headers = profile.protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : key ? { authorization: 'Bearer ' + key } : {};
    let limit;
    for (const url of [base + '/models/' + encodeURIComponent(profile.model), base + '/models']) {
        signal.throwIfAborted();
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' });
            if (!response.ok) { await response.body?.cancel(); continue; }
            let text = ''; for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) { text += chunk; if (text.length > 2000000) throw new Error('Model metadata too large'); }
            const data = JSON.parse(text), info = Array.isArray(data.data) ? data.data.find(m => m.id === profile.model) : data;
            limit = outputLimit(info); if (limit) break;
        } catch { signal.throwIfAborted(); }
    }
    cache.set(id, { time: Date.now(), limit }); if (cache.size > 100) cache.delete(cache.keys().next().value);
    return limit;
}
module.exports = { automaticOutputLimit, outputLimit };
