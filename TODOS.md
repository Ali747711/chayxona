# Chayxona — Deferred TODOs

## Active Scope for v0.5.0 (Locked in by /plan-ceo-review)
- **Core v2 Safe Single-Writer Task Implementation Mode:** `/task`, Git worktree leases (`$CHAYXONA_DATA_DIR/worktrees/<roomId>/<taskId>`), automated `check-runner` verification loop, human `/approve` and atomic `/apply`.
- **Turnkey GitHub Action & CI Mode:** Composite `action.yml` (Node 22 setup, build step, `@anthropic-ai/claude-code` installer), `.github/workflows/chayxona-review.yml`, `--ci` exit code semantics, and in-place sticky comment upserting (`<!-- chayxona-pr-review -->`).
- **Formal `DESIGN.md` Design System Doc:** Authoritative documentation of TUI layout breakpoints (<80 cols, <24 rows), ANSI tokens, 1-col glyphs, and `NO_COLOR=1` a11y.

## Deferred Roadmap Items

### 1. Persistent Warm Transports (ACP / App-Server)
- **What:** Add persistent provider transports (`agy acp`, Codex app-server) and local stdio bridges.
- **Why:** Eliminates per-turn subprocess cold-start latency when running rapid interactive turns.
- **Pros:** Faster turn-to-turn responsiveness.
- **Cons:** Tight coupling to vendor CLI daemon protocols that vary across releases.
- **Context:** v1 and v2 deliberately use stateless subprocess-per-turn with `stdin` + JSONL streaming to guarantee native read-only flags and explicit directory scoping on every invocation.
- **Effort estimate:** M (human: ~2 weeks / CC: ~30 min)
- **Priority:** P2
- **Depends on:** v0.5.0 shipped and benchmarked on real codebases.
