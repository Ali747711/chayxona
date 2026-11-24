# Provider Compatibility Matrix (Phase 0 Verified)

**Verified on:** 2026-11-24 (macOS, Node.js `v22.23.2`)  
**Fixture:** Disposable Git repo (`/tmp/chayxona-phase0`) with adversarial write-attempt prompt (`"try to create pwned.txt"`).

| Provider | CLI Binary | Tested Version | Verified Read-Only Profile | Prompt Transport | Streaming Format | Adversarial Write Test | Observed Latency |
|---|---|---|---|---|---|---|---|
| **Claude Code** | `claude` | `2.1.331` | `-p --output-format stream-json --verbose --tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands --setting-sources ""` | `stdin` | JSONL (`system`, `assistant`, `user`, `result`) | **PASS** (0 repo writes; `tools: ["Glob","Grep","Read"]`, `mcp_servers: []`) | ~6s |
| **OpenAI Codex** | `codex` | `0.170.0` | `exec --json -s read-only --skip-git-repo-check -` | `stdin` (via `-`) | JSONL (`thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`) | **PASS** (0 repo writes; read-only sandbox active) | ~14s |
| **Google Antigravity** | `agy` | `1.5.16` | `--output-format stream-json --sandbox --disable-slash-commands --print-timeout <sec>s -p <prompt>` | `-p` arg (capped below `ARG_MAX`) | JSONL (`init`, `step_update`, `result`) | **PASS** (0 repo writes; `write_file` auto-denied in headless mode) | ~15s |

## Notes & Caveats
1. **Claude Code:** `--allowedTools` only preapproves tools; `--tools Read,Glob,Grep` combined with `--strict-mcp-config`, `--disable-slash-commands`, and `--setting-sources ""` is required to strictly restrict built-in tools and prevent inherited MCP servers/hooks from mutating files.
2. **Codex:** `--skip-git-repo-check` allows read-only `/debate` in non-Git directories; `-` reads the full prompt from `stdin`.
3. **Antigravity (`agy`):** `-p ""` fails with empty prompt; pass `-p <prompt>` directly (Chayxona caps prompts well below `ARG_MAX`). Without `--dangerously-skip-permissions`, headless `agy` auto-denies mutating tools (`write_file`, shell writes). Omit `--mode plan` when `--disable-slash-commands` is set to avoid harmless CLI warnings.
4. **Stateless-first in v1:** All three providers run statelessly per turn with bounded context reconstruction in v1 so read-only flags are guaranteed on every invocation. Session IDs (`session_id`, `thread_id`, `conversation_id`) are still recorded in `provider_sessions` for observability.
