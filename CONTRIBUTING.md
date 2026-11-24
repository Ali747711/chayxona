# Contributing to Chayxona

Thanks for contributing to **Chayxona**!

## Development Setup

Requires **Node.js >= 22.5** (uses built-in `node:sqlite`, zero native compilation).

```bash
git clone https://github.com/Ali747711/chayxona.git
cd chayxona
npm install
npm run typecheck
npm run build
npm test
```

## Testing Rules
- All default tests in `tests/` **must** be 100% deterministic and offline using `FakeAgentAdapter` and temporary Git repos — never invoke live paid CLIs in default `npm test`.
- Keep provider-specific JSONL parsing isolated inside `src/adapters/{claude,codex,agy}.ts` and add fixture tests when updating parsers.
- Any TUI change must respect `NO_COLOR=1` and avoid wide emojis inside bordered Ink `<Box>` components.

## Pull Request Checklist
1. `npm run typecheck` passes with 0 errors.
2. `npm run build` succeeds cleanly.
3. `npm test` passes (all unit, integration, and E2E suites).
4. `chayxona debate "smoke" --fake --no-tui` exits `0`.
5. Update `docs/PROVIDER_COMPATIBILITY.md` if CLI flags or read-only profiles change.
