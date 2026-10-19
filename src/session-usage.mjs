/** Provider counters are cumulative. Cached input and reasoning are subsets in
 * Codex, while agy reports cached reads separately from its input/total. Keep
 * both the provider total and all processed tokens; never add reasoning twice. */
const count = value => Number.isSafeInteger(value) && value >= 0
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'providerTotalTokens']

export function normalizeUsage(provider, raw) {
  if (!raw) return null
  const u = provider === 'codex' ? {
    inputTokens: raw.inputTokens, cachedInputTokens: raw.cachedInputTokens,
    outputTokens: raw.outputTokens, reasoningTokens: raw.reasoningOutputTokens,
    totalTokens: raw.totalTokens, providerTotalTokens: raw.totalTokens,
  } : {
    inputTokens: raw.input_tokens, cachedInputTokens: raw.cache_read_tokens,
    outputTokens: raw.output_tokens, reasoningTokens: raw.thinking_tokens,
    totalTokens: count(raw.total_tokens) && count(raw.cache_read_tokens) ? raw.total_tokens + raw.cache_read_tokens : null,
    providerTotalTokens: raw.total_tokens,
  }
  if (fields.some(key => !count(u[key]))) return null
  if (provider === 'agy') u.inputTokens += u.cachedInputTokens
  if (u.cachedInputTokens > u.inputTokens || u.reasoningTokens > u.outputTokens) return null
  return u
}

export function usageDelta(current, previous = null) {
  if (!current) return null
  const delta = Object.fromEntries(fields.map(k => [k, current[k] - (previous?.[k] || 0)]))
  return fields.every(k => count(delta[k])) ? delta : null
}

export function sumUsage(rows) {
  if (rows.some(row => !row)) return null
  return Object.fromEntries(fields.map(k => [k, rows.reduce((sum, row) => sum + row[k], 0)]))
}
