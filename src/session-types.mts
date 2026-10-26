/** Shared contracts for the local bridge. Runtime input checks still guard external data. */
export type Provider = 'codex' | 'agy'
export type Transport = 'console' | 'stdio' | 'pty' | 'agentapi'
export type SessionState = 'starting' | 'running' | 'idle' | 'awaiting_user' | 'settling' | 'closed' | 'unknown'
export type RequestState = 'sending' | 'submitted' | 'unknown' | 'completed' | 'failed' | 'superseded'
export type ConnectionState = 'connected' | 'closed' | 'unreachable' | 'unverified'
export type HookEvent = 'SessionStart' | 'PreInvocation' | 'Stop'

export interface Usage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  providerTotalTokens: number
}
export interface PendingApproval { id: string | number; method?: string; [key: string]: unknown }
export interface SessionRecord {
  id: string
  provider: Provider
  transport?: Transport
  workspaces: string[]
  repos: string[]
  state?: SessionState
  pid?: number
  startedAt?: string
  registeredAt: string
  event?: string
  fullyIdle?: boolean
  conversationId?: string
  transcript?: string
  model?: string | null
  role?: string
  usage?: Usage | null
  usageKnown?: boolean
  maxTokens?: number
  pendingApproval?: PendingApproval
  executable?: string
  address?: string
  token?: string
}
export type PublicSession = Pick<SessionRecord, 'id' | 'provider' | 'workspaces' | 'model' | 'transport' |
  'state' | 'pid' | 'registeredAt' | 'event' | 'fullyIdle' | 'role' | 'usage' | 'usageKnown' | 'maxTokens' | 'pendingApproval'>
export interface SessionSnapshot extends PublicSession {
  lastKnownState: SessionState | null
  state: SessionState
  connection: ConnectionState
  checkedAt: string
}
export interface RequestRecord {
  id: string
  to: string
  from: string
  repo: string
  prompt: string
  createdAt: string
  baseline: number | null
  state: RequestState
  receipt?: unknown
  result?: unknown
  error?: string
  completedAt?: string
  conversationId?: string
  usage?: Usage | null
}
export interface DispatchOptions { to: string; prompt: string; cwd: string; from?: string; dialogueId?: string | null }
export interface HookInput {
  conversationId?: string
  workspacePaths?: string[]
  transcriptPath?: string
  modelName?: string
  fullyIdle?: boolean
  model?: string
  session_id?: string
  prompt?: string
  last_assistant_message?: unknown
}
export type LocalRequest = Pick<RequestRecord, 'id' | 'to' | 'prompt'> & Partial<Pick<RequestRecord, 'from'>>
export type LocalMessage = { token?: string } & (
  { action: 'status' } | { action: 'result'; id: string } |
  { action: 'answer'; id: string | number; decision: string } |
  { action: 'submit'; request: LocalRequest } |
  { action: 'hook'; event: string; input: HookInput }
)
export interface JobRecord {
  id: string; to: string; state: RequestState; result?: unknown; error?: string; completedAt?: string
  baseline?: Usage | null; baselineKnown?: boolean; usage?: Usage | null; conversationId?: string
  turnId?: string; rawUsage?: unknown; observed?: boolean; interrupted?: boolean
}
export interface TranscriptEntry { type?: string; source?: string; status?: string; content?: unknown }
export interface ConsoleSnapshot { pid: number; startedAt: string; screen: string; ignored?: false }
export interface DialogueTurn {
  index: number; to: string; from: string; requestId: string; state: RequestState
  usage?: Usage | null; conversationId?: string; error?: string; message?: string; done?: boolean
}
export type DialogueState = 'queued' | 'running' | 'stopping' | 'failed' | 'cancelled' | 'token_limit' |
  'unknown' | 'usage_unavailable' | 'message_limit' | 'invalid_response' | 'completed' | 'turn_limit'
export interface DialogueRecord {
  id: string; repo: string; left?: string; right?: string; state: DialogueState; createdAt?: string
  limits?: { maxTurns: number; maxTokens: number; maxMessageChars: number; timeoutMs: number }
  turns: DialogueTurn[]; usage?: Usage | null; knownUsage?: Usage | null; usagePending?: boolean
  reason?: string; endedAt?: string
}
export interface DialogueOptions {
  id?: string; left: string; right: string; prompt: string; cwd?: string
  maxTurns?: number; maxTokens?: number; maxMessageChars?: number; timeoutMs?: number
  onEvent?: (event: Record<string, unknown>) => void
  dispatch?: (options: DispatchOptions) => RequestRecord
  result?: (id: string, cwd: string) => RequestRecord
  inventory?: (cwd: string) => PublicSession[]
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
