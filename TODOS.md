# Chayxona — Roadmap & Accomplishments

## Released in v0.5.0 & Extensions
- [x] **Core v2 Safe Single-Writer Task Implementation Mode:** `/task`, Git worktree leases (`$CHAYXONA_DATA_DIR/worktrees/<roomId>/<taskId>`), automated `check-runner` verification loop, active ID fallbacks, sequential verification retry, human `/approve`, `/reject`, `@implementer` steering, and atomic `/apply`.
- [x] **Turnkey GitHub Action & CI Mode:** Composite `action.yml` (Node 22 setup, build step, `@anthropic-ai/claude-code` installer), `.github/workflows/chayxona-review.yml`, `chayxona pr --ci` exit code semantics (`0` clean, `2` blocking findings / dissents, `1` fatal error), 0-key fork fallback, and in-place sticky comment upserting (`<!-- chayxona-pr-review -->`).
- [x] **Formal `DESIGN.md` Design System Doc:** Authoritative documentation of TUI layout breakpoints (<80 cols, <24 rows), ANSI tokens, 1-col ASCII glyphs, signature agent palettes, and `NO_COLOR=1` a11y.
- [x] **Interactive Diff Hunk Browser (`/diff [file|number]`):** Zero-truncation file filtering, per-file addition/deletion stats, and live working-tree fallback.
- [x] **One-Command Bot Scaffolding (`chayxona init --action`):** Instantly bootstrap `.github/workflows/chayxona-review.yml` into any repo.
- [x] **Persistent Warm Transports (`WarmTransportPool` & `/warm`):** Session continuity and session ID reuse across Claude Code (`--resume`), Codex (`resume`), and Antigravity (`--resume`).
- [x] **Local Stdio MCP Room Server (`chayxona mcp`):** Exposes `chayxona_debate`, `chayxona_audit`, and `chayxona_review_pr` tools directly over Model Context Protocol for Cursor, Claude Desktop, and Windsurf.
- [x] **Animated Terminal Demo & Visual Header:** Created `docs/demo.cast` and razor-sharp `docs/demo.svg` vector preview showcasing side-by-side multi-agent debate in README.
- [x] **Automated NPM Publish & GitHub Release (`.github/workflows/publish.yml`):** OIDC-backed publishing with cryptographic npm provenance and automated release notes on tag push.
- [x] **Multi-Format Room Export (`chayxona export [roomId]` & `/export`):** Secret-redacted export supporting standalone dark-mode HTML reports, GitHub PR decision cards, Markdown transcripts, and structured JSONL.

---

## Deferred Roadmap Items

### 1. OS-Level Kernel Sandboxing (Bubblewrap / Seatbelt)
- **What:** Optional Linux `bwrap` and macOS `sandbox-exec` kernel sandbox wrapping around subprocess turns.
- **Why:** Hardware-enforced process isolation beyond process-level working directory boundaries and CLI read-only profiles.
- **Context:** Currently, Chayxona enforces read-only safety using native CLI vendor profiles (`--tools Read,Glob,Grep`, `--sandbox read-only`) and cooperative Git worktrees with out-of-repo SQLite state.
- **Effort estimate:** L (human: ~3 weeks / CC: ~45 min)
- **Priority:** P3
