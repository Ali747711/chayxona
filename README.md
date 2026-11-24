# Chayxona

[![CI](https://github.com/Ali747711/chayxona/actions/workflows/ci.yml/badge.svg)](https://github.com/Ali747711/chayxona/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**One repository, one terminal room, multiple independent coding CLIs debating, cross-reviewing, and safely implementing code live — with zero new API keys.**

Chayxona (named after the Central Asian teahouse where people gather to debate and share ideas) orchestrates your already-installed, already-authenticated local coding CLIs (**Claude Code**, **OpenAI Codex CLI**, and **Google Antigravity CLI**) inside a single local-first terminal room.

## Why Chayxona?
- **Anti-sycophancy by default (Blind Round 1 -> Cross-Exam Round 2):** Every `/debate` and `/audit` runs an independent blind first pass (takes stay sealed until all agents finish) followed by live cross-examination so models expose each other's blind spots instead of anchoring on the first speaker.
- **Zero new API keys:** Uses your existing local `claude`, `codex`, and `agy` CLI subscriptions directly.
- **Read-only by default + Safe Write-Mode (`/task`):** Debates and audits never mutate your repo (all `node:sqlite` state lives out-of-repo under `$CHAYXONA_DATA_DIR`). When you want code changes, `/task` runs a human-gated workflow: read-only plan -> `/approve` -> exclusive single-writer in an isolated Git worktree -> read-only cross-review -> hash-bound `/apply`.
- **Zero native compile:** Uses Node 22's built-in `node:sqlite` (`WAL` + `BEGIN IMMEDIATE`).

## Quickstart

Requires **Node.js >= 22.5** and at least 2 of `claude`, `codex`, or `agy` installed locally.

```bash
git clone https://github.com/Ali747711/chayxona.git
cd chayxona
npm install
npm run build
npm link

# Probe local CLIs and verified read-only profiles
chayxona doctor

# Optional: initialize .chayxona.json in your repo
chayxona init

# Start an interactive terminal room
chayxona start

# Try instantly with deterministic fake providers (0 LLM cost)
chayxona debate "Cache-aside Redis vs read replicas" --fake --no-tui

# Non-interactive CI / piped debate or audit (exit 0=complete, 2=degraded, 1=fatal)
chayxona debate "Should we split the auth service?" --no-tui
chayxona audit diff --no-tui
```

## Real 3-CLI Debate Example (Dogfooding Chayxona)
When we ran Chayxona's first live 3-CLI debate on its own `src/orchestrator/room-service.ts`, Claude, Codex, and Antigravity independently inspected the file in Blind Round 1, then cross-examined each other in Round 2 — producing **10 structured findings**, **2 explicit cross-model dissents**, and catching **3 real concurrency races** before we even finished v0.1.0:

```text
## Room Summary (r-2e598f39)
- Turns used: 6/24 | Findings: 10 (2 with explicit dissent)

### Findings by File
- src/orchestrator/room-service.ts
  - [HIGH]   R1-r1-claude-F1:103 — Paused-R2 / new-round overlap lacks isRunning guard
  - [HIGH]   R1-r1-agy-F1:568    — stop('all') / unseal doesn't halt queued agents when maxConcurrency < agents
  - [MEDIUM] R1-r1-claude-F2:702 — Abort-after-completion race discards a finished take
  - [MEDIUM] R1-r2-agy-F3:702    — Confirms race, refines trigger [DISSENTS: R1-r1-claude-F2]
```

## In-Room Commands

| Command | Behavior |
|---|---|
| `/debate <topic>` | Blind Round 1 -> Cross-Exam Round 2 across all active agents |
| `/audit [diff\|staged\|head]` | Read-only audit of working tree diff, staged diff, or `HEAD` |
| `/task <description>` | **Safe Write-Mode:** Plan -> `/approve` -> isolated Git worktree single-writer -> read-only cross-review -> `/apply` |
| `/approve <id>` / `/reject <id> <reason>` | Resolve pending plan or final hash-bound approval |
| `/diff` / `/apply <rev>` | Inspect colorized task diff / apply approved patch (refuses if `HEAD` diverged) |
| `/agents` | List active agents and `@mention` usage |
| `@claude\|@codex\|@agy <msg>` | Targeted single-agent turn |
| `@all <msg>` or plain text | Broadcast freeform turn (or queues R2 steering note during Blind R1) |
| `Tab` | Autocomplete `/` or `@` while typing; toggle Findings & Dissent panel when idle |
| `Up` / `Down` | Recall previous prompts from session history |
| `/unseal` or `Ctrl+U` | Interrupt straggler once `>= 2` R1 takes finish and proceed to R2 |
| `/summary` | Local zero-LLM-cost summary of findings and dissent |
| `/budget +<n>` | Extend room turn budget |
| `/pause` / `/continue` | Pause before Cross-Exam R2 / resume |
| `/recover retry\|unseal\|r2` | Recover an interrupted round after `chayxona resume` |
| `/stop [agent\|all]` | Cancel active turn(s) and reap detached POSIX process groups |
| `/export [md\|jsonl] [path]` | Export secret-redacted transcript |

## Security & Compatibility
- Read-only CLI profiles & Phase 0 verification: [docs/PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md)
- Roadmap & future work: [TODOS.md](TODOS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
