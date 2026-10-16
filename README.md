# axMap

[![English](https://raw.githubusercontent.com/rl2aderjoon/axmap/main/docs/assets/readme-en.svg)](https://github.com/rl2aderjoon/axmap/blob/main/README.md) [![한국어](https://raw.githubusercontent.com/rl2aderjoon/axmap/main/docs/assets/readme-ko.svg)](https://github.com/rl2aderjoon/axmap/blob/main/README.ko.md)

**A CLI tool that helps AI agents avoid conflicting edits by claiming paths before working in the same Git repository.**

axMap records who is editing which paths and rejects overlapping claims.
Commit hooks check changes against claimed paths, and agents release their claims when work is done.
AI tools can use the same workflow through MCP.

Requires Node.js 20+ and Git. The CLI has no npm runtime dependencies.
The npm package is `axmap-cli`; the command is `axmap`.

## Installation

Run these commands from any folder, including outside a Git repository.

```bash
npm install -g axmap-cli@latest
axmap setup
```

`setup` installs axMap and registers MCP in your AI tool's user settings. It does not bind the installation to the current folder or initialize a repository.
Restart your AI tool after setup to use MCP.
People and agents working together must share the same remote ledger to see each other's claims.

During interactive setup, enter the name people should use for messages, such as `John Smith` or `장효준`. To set or correct it without a prompt, run `axmap setup --name "John Smith"`. Reinstallation keeps the saved name. Git's name and email settings are unchanged.

On first use in a repository, axMap reads that repository's Git email and shares your display name through the existing `axmap/users` branch. No code commit or per-repository manual registration is needed. Teammates discover it when their user information synchronizes. This requires push access; an offline or rejected update is reported and retried. Setup alone does not announce you to repositories you have never used.

Use `axmap bus contacts` to list known names and email addresses. Messages sent to a known name are addressed to its email, so correcting the name preserves delivery and read history. If multiple people use the same name, specify the recipient's email. Messaging registration does not grant voting or MR approval rights.

See [docs/INSTALL.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INSTALL.md) for installation and configuration details (Korean).

## 1.3.3: Windows Codex registration fix

`axmap setup` now registers Codex correctly when Codex is installed through npm on Windows. It launches the package's Node entry directly, preserving paths and arguments without a shell.

## Global setup and automatic repositories in 1.3.1

Set up axMap once, then open Codex or another AI CLI in any Git repository. axMap selects that session's repository and prepares its ledger on the first status or claim request. There is no per-repository `axmap init` step.

Existing remote ledgers are reused. Linked worktrees share one ledger, and simultaneous sessions in different repositories keep independent targets. Remote access failures stop the request instead of creating a separate ledger.

MCP follows workspace roots supplied by the client. When roots are unsupported, it uses the launch directory; pass the absolute working directory through the tool's `cwd` argument for later directory changes. Run `axmap hook install` in each repository where you want commit enforcement.

To upgrade an existing installation, run this once from any folder, then restart your AI CLI:

```bash
npm install -g axmap-cli@latest
axmap setup
```

`setup` refreshes the installed MCP and shared hook runner as well as its registration. Subsequent repository changes do not require another setup or init. To explicitly prepare one repository and its commit hook during setup, use `axmap setup --repo <path>`.

## Workflow

```bash
# Check who has claimed which paths
axmap status

# Declare your paths and purpose before editing
axmap claim src/auth --agent my-agent --session my-session --task T-12 --intent "Handle token expiration"

# After editing, stage your changes and check their claimed scope
git add src/auth
axmap verify --agent my-agent --session my-session

# Release your claims when work is done
axmap release --agent my-agent --session my-session
```

Use a unique agent name and session for each work session, and keep them consistent from claim to release.
Set the `AXMAP_AGENT` and `AXMAP_SESSION` environment variables so commit hooks use the same identity.
If a claim is rejected, check its owner, purpose, and remaining time, then choose a different area.
Claim only the paths you need. For longer tasks, run `axmap renew` with the same agent and session.

Work folders created with `git worktree` share the same ledger.
`release` releases paths claimed by the current session.

## How it works

Git detects text conflicts when changes are merged.
axMap claims paths before edits to prevent agents from working on the same area at the same time.

The claim ledger lives on a dedicated Git branch. axMap checks the latest remote ledger,
then uses atomic Git ref updates and path overlap checks to acquire claims.
Commit hooks compare staged changes with claimed paths.
`axmap audit` replays the ledger history to check for rule violations.

axMap reports unreadable state and refuses operations it cannot safely evaluate.
The protocol is documented in [docs/SPEC.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/SPEC.md), and its invariants in [docs/INVARIANTS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INVARIANTS.md) (Korean).

## Using AI tools

With MCP connected, AI agents can call tools such as `ax_claim`, `ax_status`, and `ax_release`.
Give your agents these working rules.

```text
Before editing files, declare the paths and purpose with ax_claim.
If a claim is rejected, check its owner and choose another task with no overlapping paths.
Release your claims with ax_release when work is done.
```

See [mcp/README.md](https://github.com/rl2aderjoon/axmap/blob/main/mcp/README.md) for connection instructions and the tool list (Korean).

## Development and verification

```bash
git clone https://github.com/rl2aderjoon/axmap.git
cd axmap
node bin/axmap.mjs --version
npm test
npm run demo
npm run demo:compare
npm run demo:chaos
```

The root CLI runs without `npm install`. The demos require Bash.
Use `node bin/axmap.mjs` to run the source version.

The following supporting documents are currently in Korean.

| Document | Contents |
|---|---|
| [CLAUDE.md](https://github.com/rl2aderjoon/axmap/blob/main/CLAUDE.md) | Rules for working on the source |
| [docs/INSTALL.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INSTALL.md) | Installation and usage |
| [docs/SPEC.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/SPEC.md) | Commands and the claim protocol |
| [docs/INVARIANTS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INVARIANTS.md) | Invariants and verification criteria |
| [docs/DECISIONS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/DECISIONS.md) | Product scope and design decisions |

## License

[MIT](https://github.com/rl2aderjoon/axmap/blob/main/LICENSE)
