// Generated from src/session-usage.mts. Edit the .mts source and run npm run build.
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'providerTotalTokens'];
export function normalizeUsage(provider, raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const counters = raw;
    const candidate = provider === 'codex' ? {
        inputTokens: counters.inputTokens, cachedInputTokens: counters.cachedInputTokens,
        outputTokens: counters.outputTokens, reasoningTokens: counters.reasoningOutputTokens,
        totalTokens: counters.totalTokens, providerTotalTokens: counters.totalTokens,
    } : {
        inputTokens: counters.input_tokens, cachedInputTokens: counters.cache_read_tokens,
        outputTokens: counters.output_tokens, reasoningTokens: counters.thinking_tokens,
        totalTokens: count(counters.total_tokens) && count(counters.cache_read_tokens) ? counters.total_tokens + counters.cache_read_tokens : null,
        providerTotalTokens: counters.total_tokens,
    };
    if (fields.some(key => !count(candidate[key])))
        return null;
    // All six fields have been checked above, including provider-specific counters.
    const u = candidate;
    if (provider === 'agy')
        u.inputTokens += u.cachedInputTokens;
    if (u.cachedInputTokens > u.inputTokens || u.reasoningTokens > u.outputTokens)
        return null;
    return u;
}
export function usageDelta(current, previous = null) {
    if (!current)
        return null;
    const delta = Object.fromEntries(fields.map(k => [k, current[k] - (previous?.[k] || 0)]));
    return fields.every(k => count(delta[k])) ? delta : null;
}
export function sumUsage(rows) {
    const known = rows.filter((row) => Boolean(row));
    if (known.length !== rows.length)
        return null;
    return Object.fromEntries(fields.map(k => [k, known.reduce((sum, row) => sum + row[k], 0)]));
}
