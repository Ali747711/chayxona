# Chayxona

[![npm version](https://img.shields.io/npm/v/chayxona.svg)](https://www.npmjs.com/package/chayxona)
[![Version](https://img.shields.io/badge/version-v0.5.0-blue.svg)](https://github.com/Ali747711/chayxona/releases/tag/v0.5.0)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Design System](https://img.shields.io/badge/design-DESIGN.md-orange.svg)](DESIGN.md)

**One repository, one terminal room, multiple independent coding CLIs debating, cross-reviewing, and safely implementing code live — with zero new API keys.**

Chayxona (named after the Central Asian teahouse where people gather to debate and share ideas) orchestrates your already-installed, already-authenticated local coding CLIs (**Claude Code**, **OpenAI Codex CLI**, and **Google Antigravity CLI**) inside a single local-first terminal room.

<p align="center">
  <img src="docs/demo.svg" alt="Chayxona Multi-Agent Terminal Debate Demo" width="850">
</p>

---

## Why Chayxona?

- **Anti-Sycophancy by Default (Blind Round 1 -> Cross-Exam Round 2):** Every `/debate` and `/audit` runs an independent blind first pass (takes stay sealed until all agents finish) followed by live cross-examination so models expose each other's blind spots instead of anchoring on the first speaker.
- **Zero New API Keys:** Uses your existing local `claude`, `codex`, and `agy` CLI subscriptions directly.
- **Read-Only by Default + Safe Single-Writer Mode (`/task`):** Debates and audits never mutate your repo (all `node:sqlite` state lives out-of-repo under `$CHAYXONA_DATA_DIR`). When you want code changes, `/task` runs a human-gated workflow: read-only plan -> `/approve` -> exclusive single-writer in an isolated Git worktree -> automated check runner -> read-only cross-review -> atomic `/apply`.
- **Zero Native Compile:** Built on Node 22's native `node:sqlite` (`WAL` + `BEGIN IMMEDIATE`).
- **Turnkey GitHub Action PR Review Bot:** Add multi-model adversarial PR reviews to any repo with 1 YAML file.

---

## Quickstart

Requires **Node.js >= 22.5** and at least 2 of `claude`, `codex`, or `agy` installed locally.

### Option A: Run directly with npx (zero install)
```bash
# Check installed CLI providers
npx chayxona doctor

# Launch the interactive terminal room
npx chayxona start

# Automated PR review
npx chayxona pr <number>
```

### Option B: Install globally
```bash
npm install -g chayxona
chayxona doctor
chayxona start
```

# Start an interactive terminal room
chayxona start

# Try instantly with deterministic fake providers (0 LLM cost)
chayxona debate "Cache-aside Redis vs read replicas" --fake --no-tui

# Non-interactive CI / piped debate, audit, or GitHub PR cross-review
chayxona debate "Should we split the auth service?" --no-tui
chayxona audit diff --no-tui
chayxona pr 42 --post

# Export debate transcripts, GitHub PR cards, or standalone HTML reports
chayxona export latest --format md
chayxona export latest --format html --out /tmp/report.html
chayxona export latest --format pr
```

---

## Turnkey GitHub Action PR Review Bot

You can drop Chayxona directly into your GitHub CI pipeline to run automated multi-model code reviews on every pull request.

Create `.github/workflows/chayxona-review.yml`:

```yaml
name: Chayxona PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    name: Cross-Model PR Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Run Chayxona Review
        uses: Ali747711/chayxona@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Action Features
- **Sticky In-Place Comments:** Uses `<!-- chayxona-pr-review -->` to update its existing review comment on subsequent commits instead of spamming PR activity.
- **Fork PR Security:** Automatically skips review with a graceful `::warning::` if repository secrets are unavailable on external fork PRs.
- **CI Exit Codes:** Returns `exitCode = 0` for clean reviews, `exitCode = 2` for blocking findings (`critical` or `high`) or active dissents, and `exitCode = 1` for runtime errors.

---

## Model Context Protocol (MCP) Server

Chayxona includes a built-in stdio MCP server (`chayxona mcp`), allowing **Cursor**, **Claude Desktop**, and **Windsurf** to trigger multi-agent debates, audits, and PR reviews directly from your editor.

### Available MCP Tools
- **`chayxona_debate`** — Run an anti-sycophantic 2-round cross-model debate (Blind R1 -> Cross-Exam R2) across Claude, Codex, and Antigravity.
- **`chayxona_audit`** — Independent read-only multi-agent audit on working tree diff, staged edits, or `HEAD`.
- **`chayxona_review_pr`** — Cross-review GitHub pull requests and return structured findings & dissents.

### Editor Setup

Add Chayxona to your MCP config (`.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "chayxona": {
      "command": "chayxona",
      "args": ["mcp"]
    }
  }
}
```

Or test with zero LLM cost using fake providers:
```json
{
  "mcpServers": {
    "chayxona": {
      "command": "chayxona",
      "args": ["mcp", "--fake"]
    }
  }
}
```

---

## Safe Task Implementation Workflow (`/task`)

When you want an agent to implement a feature or fix a bug, Chayxona guarantees **strict write isolation**:

```text
/task "Add healthcheck endpoint"
       │
       ▼
[Plan Phase] ─── (Read-only agents draft implementation strategy)
       │
       ▼
   /approve     ─── (Human reviews and approves plan)
       │
       ▼
[Worktree Lease] ── (Allocates isolated worktree under ~/.chayxona/worktrees)
       │
       ▼
 [Writer Turn]   ── (Exclusive single-writer agent edits files in worktree)
       │
       ▼
 [Check Runner]  ── (Runs npm test / build; auto-retries implementer on failure)
       │
       ▼
[Review Loop]   ── (Read-only peer agents review diff in worktree)
       │
       ▼
    /apply      ── (Human reviews final diff & applies cleanly into working tree)
```

- `/task [--auto-plan] <desc>` — Starts task planning (or auto-approves plan directly to worktree lease).
- `/approve` — Approves the pending plan or latest revision.
- `/reject [reason]` — Cancels the task and cleanly unmounts the worktree.
- `/apply` — Applies the verified patch into your target repository.
- `@implementer <msg>` — Steers a failed task with an additional revision budget.

---

## In-Room Commands

| Command | Behavior |
|---|---|
| `/debate <topic>` | Blind Round 1 -> Cross-Exam Round 2 across all active agents |
| `/audit [diff\|staged\|head]` | Read-only audit of working tree diff, staged diff, or `HEAD` |
| `/task [--auto-plan] <desc>` | **Safe Write-Mode:** Isolated worktree single-writer implementation |
| `/approve` / `/reject [reason]` | Approve or reject pending plan, revision, or implementation |
| `/diff` / `/checks` / `/apply` | Inspect colorized worktree diff, check outputs, or apply approved patch |
| `/agents` / `/role <agent> <lens>` | List agents or switch role lens (`architect`, `security`, `performance`, `skeptic`, `reviewer`, `implementer`) |
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
| `/export [md\|jsonl\|pr] [path]` | Export secret-redacted transcript or GitHub PR decision card |

---

## Design System & Architecture

- **Terminal Design & Glyphs:** See [DESIGN.md](DESIGN.md) for layout breakpoints, 1-column ASCII glyphs invariant, and `NO_COLOR=1` compliance.
- **System Architecture & Data Flows:** See [ARCHITECTURE.md](ARCHITECTURE.md) for database schemas, IPC locks, and worktree lifecycle state machines.
- **Provider Compatibility Profiles:** See [docs/PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md) for exact CLI flags.
- **Roadmap & Deferred Items:** See [TODOS.md](TODOS.md).
