/** Provider counters are cumulative. Cached input and reasoning are subsets in
 * Codex, while agy reports cached reads separately from its input/total. Keep
 * both the provider total and all processed tokens; never add reasoning twice.
 * Claude Code reports each turn separately (input, cache creation and cache reads
 * are disjoint); the managed session sums turns before calling this. */
import type { Usage, Provider } from './session-types.mjs'
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'providerTotalTokens'] as const

export function normalizeUsage(provider: Provider, raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null
  const counters = raw as Record<string, unknown>
  if (provider === 'claude') return claudeUsage(counters)
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

// Claude Code result.usage: input_tokens, cache_creation_input_tokens and
// cache_read_input_tokens never overlap, so all three are processed input.
function claudeUsage(counters: Record<string, unknown>): Usage | null {
  const input = counters.input_tokens, created = counters.cache_creation_input_tokens, read = counters.cache_read_input_tokens
  const output = counters.output_tokens, thinking = counters.thinking_tokens ?? 0
  if (![input, created, read, output, thinking].every(count)) return null
  const processed = (input as number) + (created as number) + (read as number)
  const total = processed + (output as number)
  if ((thinking as number) > (output as number)) return null
  return { inputTokens: processed, cachedInputTokens: read as number, outputTokens: output as number,
    reasoningTokens: thinking as number, totalTokens: total, providerTotalTokens: total }
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
