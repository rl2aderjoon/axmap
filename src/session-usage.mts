/** Provider counters are cumulative. Cached input and reasoning are subsets in
 * Codex, while agy reports cached reads separately from its input/total. Keep
 * both the provider total and all processed tokens; never add reasoning twice. */
import type { Usage, Provider } from './session-types.mjs'
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'providerTotalTokens'] as const

export function normalizeUsage(provider: Provider, raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null
  const counters = raw as Record<string, unknown>
  const candidate = provider === 'codex' ? {
    inputTokens: counters.inputTokens, cachedInputTokens: counters.cachedInputTokens,
    outputTokens: counters.outputTokens, reasoningTokens: counters.reasoningOutputTokens,
    totalTokens: counters.totalTokens, providerTotalTokens: counters.totalTokens,
  } : {
    inputTokens: counters.input_tokens, cachedInputTokens: counters.cache_read_tokens,
    outputTokens: counters.output_tokens, reasoningTokens: counters.thinking_tokens,
    totalTokens: count(counters.total_tokens) && count(counters.cache_read_tokens) ? counters.total_tokens + counters.cache_read_tokens : null,
    providerTotalTokens: counters.total_tokens,
  }
  if (fields.some(key => !count(candidate[key]))) return null
  // All six fields have been checked above, including provider-specific counters.
  const u = candidate as Usage
  if (provider === 'agy') u.inputTokens += u.cachedInputTokens
  if (u.cachedInputTokens > u.inputTokens || u.reasoningTokens > u.outputTokens) return null
  return u
}

export function usageDelta(current: Usage | null, previous: Usage | null = null): Usage | null {
  if (!current) return null
  const delta = Object.fromEntries(fields.map(k => [k, current[k] - (previous?.[k] || 0)])) as unknown as Usage
  return fields.every(k => count(delta[k])) ? delta : null
}

export function sumUsage(rows: ReadonlyArray<Usage | null | undefined>): Usage | null {
  const known = rows.filter((row): row is Usage => Boolean(row))
  if (known.length !== rows.length) return null
  return Object.fromEntries(fields.map(k => [k, known.reduce((sum, row) => sum + row[k], 0)])) as unknown as Usage
}
