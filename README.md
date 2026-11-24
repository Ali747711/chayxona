# Chayxona

**One repository, one terminal room, multiple independent coding CLIs debating and cross-reviewing code live — with zero new API keys and zero repository mutations in v1.**

Chayxona orchestrates your already-installed, already-authenticated local coding CLIs (**Claude Code**, **OpenAI Codex CLI**, and **Google Antigravity CLI**) inside a single local-first terminal room.

## Why Chayxona?
- **Blind Round 1 -> Cross-Exam Round 2:** Every `/debate` and `/audit` runs an independent blind first pass (takes stay sealed until all agents finish) followed by live cross-examination so models expose each other's blind spots instead of anchoring on the first speaker.
- **Zero new API keys:** Uses your existing local `claude`, `codex`, and `agy` CLI subscriptions directly.
- **Strictly `[READ-ONLY]` in v1:** All SQLite state (`node:sqlite`, zero native compile), locks, and default exports live out-of-repo under `$CHAYXONA_DATA_DIR`. Target repos stay untouched.

## Quickstart

Requires **Node.js >= 22.5** (uses built-in `node:sqlite`) and at least 2 of `claude`, `codex`, or `agy` installed locally.

```bash
npm install
npm run build
npm link

# Check local CLIs and read-only profiles
chayxona doctor

# Start an interactive read-only room
chayxona start

# Try immediately with deterministic fake providers (no live LLM calls)
chayxona debate "Cache-aside Redis vs read replicas" --fake --no-tui

# Non-interactive CI / piped debate or audit (exit 0=complete, 2=degraded, 1=fatal)
chayxona debate "Should we split the auth service?" --no-tui
chayxona audit diff --no-tui
```

## In-Room Commands

| Command | Behavior |
|---|---|
| `/debate <topic>` | Blind Round 1 -> Cross-Exam Round 2 across all active agents |
| `/audit [diff\|staged\|head]` | Read-only audit of working tree diff, staged diff, or `HEAD` |
| `/task <description>` | **v2 Safe Write-Mode:** Plan -> human `/approve` -> isolated Git worktree single-writer -> read-only cross-review -> `/apply` |
| `/approve <id>` / `/reject <id> <reason>` | Resolve pending plan or final hash-bound approval |
| `/apply <revision-id>` | Preflight & apply approved worktree patch to original repo (refuses if `HEAD` diverged) |
| `@claude\|@codex\|@agy <msg>` | Targeted single-agent turn |
| `@all <msg>` or plain text | Broadcast freeform turn (or queues R2 steering note during Blind R1) |
| `/findings` or `Tab` | Toggle Findings & Dissent panel (`j`/`k` navigate, `Tab`/`Esc` back) |
| `/unseal` or `Ctrl+U` | Interrupt straggler once `>= 2` R1 takes finish and proceed to R2 |
| `/summary` | Local zero-LLM-cost summary of findings and dissent |
| `/budget +<n>` | Extend room turn budget |
| `/pause` / `/continue` | Pause before Cross-Exam R2 / resume |
| `/stop [agent\|all]` | Cancel active turn(s) and reap detached process groups |
| `/export [md\|jsonl] [path]` | Export secret-redacted transcript |

## Security & Compatibility
See [docs/PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md) for Phase 0 verified read-only flags and [TODOS.md](TODOS.md) for the v2 write-mode roadmap.
