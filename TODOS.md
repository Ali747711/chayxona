# Chayxona — Deferred TODOs

## 1. v2 Safe Single-Writer Implementation Mode (Worktrees, OS Sandboxing, `/apply`)
- **What:** Implement single-writer Git worktree isolation, OS-level sandboxing (macOS Seatbelt / Linux Landlock/Bubblewrap), 10-state task FSM (`PLANNING -> IMPLEMENTING -> VERIFYING -> REVIEWING -> READY_TO_APPLY`), automated test checks, and `/apply`.
- **Why:** Completes the second half of `PRD.md` — turning a debated cross-CLI consensus directly into a safely implemented, independently cross-reviewed patch without risking the user's main working tree.
- **Pros:** Delivers the full end-to-end "debate -> approve -> implement -> cross-review -> apply" engineering loop on top of v1's additive SQLite schema and adapter contract.
- **Cons:** High OS-specific sandboxing and Git worktree reconciliation complexity.
- **Context:** v1 intentionally scopes strictly to a `[READ-ONLY]` live debate & audit room (`v0.1.0`) so the core differentiator ships cleanly first. All v1 SQLite tables (`rooms`, `rounds`, `turns`, `messages`, `findings`, `events`, `provider_sessions`) and adapter interfaces are designed so v2 tables (`tasks`, `approvals`, `revisions`, `checks`, `jobs`) and `permission_epoch` layer on purely additively.
- **Depends on / blocked by:** v1 (`v0.1.0`) shipped and validated on real repositories.

## 2. Persistent Warm Transports & Local MCP Room Tools
- **What:** Add persistent provider transports (`agy acp`, Codex app-server) and local stdio MCP room tools (`room_send_message`, `room_get_messages`, `room_request_review`).
- **Why:** Eliminates per-turn subprocess cold-start latency and replaces fenced `chayxona-findings` JSON blocks with native tool calls once real-world v1 usage shows where latency hurts most.
- **Pros:** Faster turn-to-turn responsiveness and cleaner structured tool invocations.
- **Cons:** Tight coupling to fast-moving vendor CLI protocols that vary across versions and can break on upstream updates.
- **Context:** v1 deliberately uses stateless subprocess-per-turn over `stdin` + JSONL streaming so native read-only flags are guaranteed on every turn with minimal fragility. Revisit after Phase 0 and v1 usage provide concrete cold-start latency measurements.
- **Depends on / blocked by:** v1 (`v0.1.0`) shipped + Phase 0/v1 cold-start latency measurements.

## 3. Formal `DESIGN.md` Design System Doc
- **What:** Create a dedicated `DESIGN.md` (via `/design-consultation`) documenting Chayxona's TUI design tokens, terminal breakpoints (`<80 cols`, `<24 rows`), and color/contrast guidelines.
- **Why:** Gives open-source contributors a single source of truth before touching TUI components or building future web/docs surfaces.
- **Pros:** Prevents visual drift, hardcoded colors, and wide-emoji Ink regressions from external PRs.
- **Cons:** Small upfront doc effort while `src/tui/theme.ts` already enforces tokens in code.
- **Context:** Added during `/plan-design-review` (`v0.3.0` -> `v0.4.0`). Currently tokens live in `src/tui/theme.ts` and `CONTRIBUTING.md` enforces `NO_COLOR=1` and 1-col glyph rules.
- **Depends on / blocked by:** None.
