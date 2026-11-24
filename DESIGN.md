# Chayxona Design System (`DESIGN.md`)

This document defines the formal design language, layout ergonomics, typography rules, color tokens, and accessibility standards for the **Chayxona** terminal user interface (TUI) and command-line outputs.

---

## 1. Design Philosophy

Chayxona is a **local-first, multi-model adversarial debate and task orchestration room** for AI coding agents (Claude, Codex, Antigravity). The design reflects three core principles:

1. **Anti-Sycophantic Clarity:** Agent identities, agreements, and dissents must be visually distinct at a glance. Unanimous consensus, partial agreements, and sharp dissents have explicit, un-ambiguous visual states.
2. **Deterministic Geometry & Zero Terminal Dirt:** The terminal is a shared canvas. Chayxona uses strict monospace boundaries, an alternate screen buffer, and guaranteed terminal state restoration on exit.
3. **Information Density without Noise:** Clean borders, quiet metadata, docked command entry, and live agent status strips keep focus on code diffs and adversarial critique.

---

## 2. Layout & Terminal Breakpoints

Chayxona renders adaptively based on standard terminal dimensions (`columns` x `rows`):

| Viewport Category | Dimensions | Layout Behavior |
|:---|:---|:---|
| **Standard Desktop** | $\ge 80$ cols, $\ge 24$ rows | Full 3-section layout: Top Header Bar with Live Badge & Agents Strip, Scrollable Message Stream, Fixed Bottom Prompt & Command Dock. Centered splash card on launch. |
| **Wide Screen** | $\ge 120$ cols | Extended diff display, wide Finding cards with inline Agree/Dissent badges, full side-by-side agent status tags. |
| **Compact / Narrow** | $< 80$ cols | Truncates long repo paths, wraps agent turn headers into single-line summaries, collapses multi-column metadata into stacked rows. |
| **Short Viewport** | $< 24$ rows | Compresses message history window and splash card margins to guarantee the bottom prompt dock remains visible and interactive without overflow. |

### Layout Structure
```
+---------------------------------------------------------------------------------+
| CHAYXONA [READ-ONLY]  Room: r-a1b2c3d4  Agents: CLAUDE, CODEX, AGY  [TASK: READY] | (Header Bar)
|---------------------------------------------------------------------------------|
| [Claude]: * Running turn 1/24...  [Codex]: o Idle  [AGY]: + Turn complete       | (Agent Strip)
|=================================================================================|
|                                                                                 |
| === CLAUDE (R1 · Blind) ===                                                     |
| Identified race condition in src/auth/token.ts:42...                            |
|                                                                                 |
| === CODEX (R2 · Cross-Exam) ===                                                 |
| Agree with Claude regarding token.ts. In addition, missing mutex lock...        |
|                                                                                 |
+---------------------------------------------------------------------------------+
| > Type a command (/task, /approve, /apply, /reject, /exit) or ask agents...     | (Prompt Dock)
+---------------------------------------------------------------------------------+
```

---

## 3. The 1-Column ASCII Glyph Invariant

> **Crucial Rule:** Never use double-width Unicode emojis (`⚠️`, `✅`, `❌`, `🚀`) inside framed TUI boxes or column-aligned layout containers.

Terminals handle double-width Unicode and emoji clusters inconsistently across platforms (macOS Terminal, iTerm2, Alacritty, Windows Terminal, Kitty, tmux). Mismatched width calculations in virtual DOM TUI engines (such as Ink) cause erratic border wrapping, misaligned cards, and visual cursor drift.

Chayxona strictly enforces **1-column ASCII status glyphs**:

| Status | 1-Col Glyph | ANSI Token | Meaning |
|:---|:---:|:---|:---|
| `running` | `*` | `yellow` | Agent is actively generating or computing turn |
| `streaming` | `>` | `greenBright` | Output tokens are actively streaming to terminal |
| `done` | `+` | `green` | Agent turn or task step finished cleanly |
| `error` | `x` | `redBright` | Agent failed or check command returned non-zero |
| `cancelled` | `-` | `yellow` | Turn or task was rejected or cancelled |
| `idle` / `pending` | `o` | `gray` | Waiting for turn or awaiting user input |

---

## 4. Color Palette & Semantic Tokens

Chayxona uses standard 16-color ANSI with 256-color fallback to ensure compatibility across all terminal emulators and remote SSH sessions.

### Signature Agent Identifiers
Each agent carries a signature hue across turn headers, status tags, and finding badges:

- **Claude:** `yellow` (`#D97706` / Amber Warm) — Representing Anthropic's signature terracotta warmth.
- **Codex:** `greenBright` (`#10B981` / Emerald Green) — Representing OpenAI's signature emerald hue.
- **Antigravity (AGY):** `cyanBright` (`#3B82F6` / Electric Cyan) — Representing Google DeepMind's sapphire/cyan palette.
- **Human / Operator:** `whiteBright` (`#F9FAFB` / Crisp White) — Visual primacy for the operator's instructions.
- **Chayxona System:** `yellowBright` (`#FBBF24` / Chayxona Amber Gold) — Highlighting orchestration, phases, and room status.

### Functional Theme Tokens

| Token | Ink / ANSI Color | Semantic Usage |
|:---|:---|:---|
| `brand` | `yellowBright` | Title logo, welcome card banner, primary highlights |
| `border` | `gray` (dim) | Resting borders, card outlines, subtle dividers |
| `borderActive` | `cyan` | Active input box focus, running task outline |
| `borderBlind` | `magenta` | Blind R1 independent review phase boundary |
| `readOnlyBadge`| `cyanBright` | Explicit confirmation of read-only execution safety |
| `dissent` | `magentaBright` | Active peer review dissents and conflicting critiques |
| `tool` | `cyan` | Live tool call notifications (`readFile`, `grepSearch`) |
| `success` | `green` | Check passed, /approve granted, /apply merged |
| `warning` | `yellow` | Non-fatal issue, dirty repo alert, retry revision |
| `error` | `redBright` | Fatal crash, check failed, blocking security finding |

### Diff Color Tokens
- Line Added (`+`): `green`
- Line Removed (`-`): `red`
- Hunk Header (`@@`): `cyan`
- File Boundary (`+++`, `---`): `whiteBright`

---

## 5. Accessibility & `NO_COLOR=1` Compliance

Chayxona provides first-class support for users with visual impairments or color-blindness, fully respecting the [`NO_COLOR`](https://no-color.org/) standard.

- When `process.env.NO_COLOR` is set to any non-zero value, all ANSI escape codes and styling attributes (`color`, `backgroundColor`) evaluate to `undefined`.
- Layout structure, box borders, and textual hierarchies remain 100% intact.
- Status is communicated solely through text labels and 1-column glyphs (e.g. `[TASK: READY]`, `* Running`, `+ Done`, `x Failed`, `[!] CRITICAL`).
- In plain text / CI output (`chayxona debate --no-tui`, `chayxona pr --ci`), all output is cleanly formatted markdown without terminal escapes.

---

## 6. Screen Buffer & Terminal Hygiene

To ensure Chayxona leaves zero artifacts or corrupted scrollbacks in the user's terminal:

1. **Alternate Screen Buffer:** On interactive startup in a TTY, Chayxona emits the DEC Private Mode command:
   ```text
   \x1b[?1049h\x1b[2J\x1b[H
   ```
   This switches to the alternate screen buffer and positions the cursor at row 1, col 1.
2. **Guaranteed Restoration:** Upon exit (whether normal `/exit`, `Ctrl+C` / `SIGINT`, or uncaught error), Chayxona restores the primary screen buffer:
   ```text
   \x1b[?1049l
   ```
   The user's prior shell session, history, and scrollback are completely unharmed.
3. **Data Isolation:** All database files (`chayxona.db`), lockfiles (`room.lock`), task worktrees, and logs reside outside target repositories under `$CHAYXONA_DATA_DIR` (`~/.chayxona` or system app-data). No repo dirt is left behind.
