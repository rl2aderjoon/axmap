# axMap

**Several AI agents. One repository. Clear ownership before every edit.**

axMap is a collaboration CLI that claims files and folders before work begins and rejects overlapping claims.
Codex, Antigravity and Claude Code can use claims, releases, status and messaging through MCP.

**English** · [한국어](README.ko.md) &nbsp; / &nbsp; Node.js 20+ · Git · MIT

## Install

```bash
npm install -g axmap-cli@latest
axmap setup
```

Run setup once from any folder, then restart your AI tool.
Each Git repository's ledger is prepared on first use. Collaborators must share the same remote ledger.

[Usage](docs/INSTALL.md) · [MCP setup](mcp/README.md) · [Development](docs/ONBOARD-TEAM.md)

Session and messaging modules are authored in strict TypeScript. See the [TypeScript development guide](docs/TYPESCRIPT.md) for the incremental migration and build workflow.

View pipeline state inside compatible MCP Apps hosts, or add it to the existing Claude Code / agy statusline. Host support varies; actual ChatGPT and Claude embedded rendering remains unverified. See [client support and setup](docs/PIPELINE-CLIENTS.md). An optional separate terminal view is available with `axmap monitor` ([guide](docs/MONITOR.md)).

---

## Changelog

Newest changes first.

### 1.7.0

<sub>October 27, 2026</sub>

**Batch routine collaboration messages at safe work boundaries and connect existing local Codex threads.**

- Use `ax_message` / `axmap bridge message` for routine updates without starting a model turn. Receivers collect messages together with `ax_mailbox` at task, test or experiment checkpoints.
- Explicit urgent reasons distinguish stop requests, data-loss risks and changes that invalidate current work. Busy recipients defer delivery; this release does not force-interrupt active work.
- Preserve message provenance and history while supporting expiration, idempotency keys and latest pending updates per sender/topic. Uncertain delivery is never automatically retried.
- Connect an existing Codex thread through its local control socket, with read-only observation of active work and idle checks before submission.
- Add the `axmap pipeline` graph, a read-only loopback web view and context-only Codex notices that do not start a new model turn.

Mailbox behavior is covered by isolated provider and CLI/MCP tests. Actual turn savings and active-work interruption are not claimed. Receivers must collect their mailbox at safe checkpoints; reconnect MCP clients to discover the new tools. Existing execution-oriented `ax_dispatch` remains available.
[Mailbox guide →](docs/SESSION-MAILBOX.md) · [Local pipeline →](docs/LOCAL-PIPELINE.md)

---

### 1.6.0

<sub>October 26, 2026</sub>

**Observe request flow and reduce the overhead of existing Windows agy connections.**

- Cache the Windows console helper instead of recompiling it for every observation, with PowerShell fallback.
- Add bounded `wait_ms` / `--wait-ms` response waiting and asynchronous MCP progress notifications.
- Add MCP Apps pipeline resources, text fallback, and optional Claude Code / agy statuslines that preserve existing commands. An optional `axmap monitor` shows the same flow in a terminal.
- Author session and pipeline modules in strict TypeScript while shipping generated JavaScript for Node.js 20+; TypeScript is not required at runtime.

Actual agy delivery, progress and native statusline completion were verified on Windows. ChatGPT / Claude UI support is capability-based and covered by protocol tests; embedded rendering in those products remains unverified. This Codex session did not expose the new pipeline tools. Local stdio support does not provide a remote ChatGPT web endpoint.
[Client setup and limits →](docs/PIPELINE-CLIENTS.md)

---

### 1.5.0

<sub>October 21, 2026</sub>

**Connect an existing Windows Antigravity conversation without restarting it.**

- Interactive `agy` sessions launched directly register through the installed hooks. Use `axmap bridge attach --pid <PID>` from the target repository for an already open console.
- `ax_dispatch` and `ax_result` preserve the existing process and conversation. Delivery requires an empty, idle input box; results match the request UUID in the transcript and the live console state.
- `axmap bridge status [--json]` checks local connections without submitting model work.
- Independent console connections currently support Windows agy only. Token-budgeted `ax_chat` still requires managed stdio sessions.

Validated against an existing real agy console and 574 passing regression tests, including independent-console registration, Unicode delivery, input protection and process identity checks.
[Connection guide →](docs/SESSION-BRIDGE.md)

---

### 1.4.0

<sub>October 20, 2026</sub>

**Codex and Antigravity can exchange tasks automatically, with measured token usage and bounded conversations.**

**Added**

- `axmap bridge serve codex|agy` explicitly starts persistent managed CLI sessions. `bridge chat` relays short messages until completion or a configured limit.
- MCP `ax_chat`, `ax_dialogue`, and `ax_chat_stop` start, inspect, and stop automatic relay. Per-request and cumulative token counts include cache details; idle waiting makes no model calls.
- The separate prototype `axmap run` command connects a user-launched interactive terminal.
- The terminal dependency ships with npm installation and is copied into setup's installed runtime.

**Removed**

- Code visualization screens, the Electron app, analysis and corpus tools, and their tests and research documents.
- Setup and MCP now share CLI discovery from a dedicated source module.

**Validation**

On Windows, actual Codex 0.163.0 and agy 1.4.2 completed a four-turn automatic exchange with retained context, followed by a two-turn MCP background exchange.
These six model turns processed 102,590 tokens, including 54,400 cached input tokens and 393 output tokens. CLI context dominates short-message costs; budgets are checked before the next turn, not enforced as a hard limit within an active turn.
The separate interactive PTY prototype remains validated with simulated programs only.
[Read the development status →](docs/SESSION-BRIDGE.md)

---

### 1.3.3

<sub>October 16, 2026</sub>

**Windows setup connects npm-installed Codex correctly.**

**Fixed**

- `axmap setup` launches the Codex package's Node entry directly.
- Paths containing spaces and quoted arguments reach Codex without shell reinterpretation.

[Release source →](https://github.com/rl2aderjoon/axmap/tree/v1.3.3)

---

### 1.3.2

<sub>October 16, 2026</sub>

**Choose your messaging name. Discover teammates automatically.**

**Added**

- Interactive setup asks for a display name. Change it with `axmap setup --name "Your name"`.
- First use in a repository shares its Git email and your display name through the team's user ledger.
- `axmap bus contacts` lists known recipients.

**Updated**

- Messages sent to a known name are addressed by email, preserving delivery and read history after name changes.
- Duplicate names require an email address. Failed profile updates are reported and retried on later use.
- Git identity settings and voting permissions remain unchanged.

[Release source →](https://github.com/rl2aderjoon/axmap/tree/v1.3.2)

---

### 1.3.1

<sub>October 15, 2026</sub>

**One setup, from any folder.**

**Updated**

- Installation and MCP registration work outside Git repositories.
- Running setup in a folder does not pin future work to that repository.
- Registration refreshes server paths and environment settings while preserving personal settings and other servers.

Use `axmap setup --repo <path>` to prepare a specific repository's ledger and commit hook.

[Release source →](https://github.com/rl2aderjoon/axmap/tree/v1.3.1)

---

### 1.3.0

<sub>October 15, 2026</sub>

**Your session follows its working repository.**

**Added**

- Status and claim commands prepare missing ledgers automatically, removing the repeated `init` step.
- MCP follows client workspace roots and their change notifications.

**Updated**

- Existing remote ledgers are reused, and linked worktrees share one ledger.
- Sessions in separate repositories keep independent targets.
- A remote access failure is never treated as an empty ledger.

Use the MCP tool's `cwd` argument when roots are unavailable or the target is ambiguous.
Run `axmap hook install` in repositories that need commit enforcement.

[Release source →](https://github.com/rl2aderjoon/axmap/tree/v1.3.0)

---

[Installation & upgrades](docs/INSTALL.md) · [Protocol](docs/SPEC.md) · [Report an issue](https://github.com/rl2aderjoon/axmap/issues) · [MIT license](LICENSE)
