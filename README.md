# axMap

[![English](docs/assets/readme-en.svg)](README.md) [![한국어](docs/assets/readme-ko.svg)](README.ko.md)

**A CLI tool that helps AI agents avoid conflicting edits by claiming paths before working in the same Git repository.**

axMap records who is editing which paths and rejects overlapping claims.
Commit hooks check changes against claimed paths, and agents release their claims when work is done.
AI tools can use the same workflow through MCP.

Requires Node.js 20+ and Git. The CLI has no npm runtime dependencies.
The npm package is `axmap-cli`; the command is `axmap`.

## Installation

Run these commands in the Git repository you want to work on.

```bash
npm install -g axmap-cli@latest
cd <your-project-repository>
axmap setup
axmap doctor
```

`setup` prepares the repository's claim ledger and commit hooks, and registers MCP in your AI tool's user settings.
Restart your AI tool after setup to use MCP.
People and agents working together must share the same remote ledger to see each other's claims.

See [docs/INSTALL.md](docs/INSTALL.md) for installation and configuration details (Korean).

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
The protocol is documented in [docs/SPEC.md](docs/SPEC.md), and its invariants in [docs/INVARIANTS.md](docs/INVARIANTS.md) (Korean).

## Using AI tools

With MCP connected, AI agents can call tools such as `ax_claim`, `ax_status`, and `ax_release`.
Give your agents these working rules.

```text
Before editing files, declare the paths and purpose with ax_claim.
If a claim is rejected, check its owner and choose another task with no overlapping paths.
Release your claims with ax_release when work is done.
```

See [mcp/README.md](mcp/README.md) for connection instructions and the tool list (Korean).

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
| [CLAUDE.md](CLAUDE.md) | Rules for working on the source |
| [docs/INSTALL.md](docs/INSTALL.md) | Installation and usage |
| [docs/SPEC.md](docs/SPEC.md) | Commands and the claim protocol |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | Invariants and verification criteria |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Product scope and design decisions |

## License

[MIT](LICENSE)
