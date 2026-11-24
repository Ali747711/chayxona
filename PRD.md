# Chayxona — Product Requirements Document

**Version:** 1.0 · **Status:** Proposed implementation baseline · **Date:** 2026-11-24  
**Target:** Google Antigravity coding agent implementing a local TypeScript CLI  
**Working name:** Chayxona (verify availability before public distribution).

## 1. Product vision

Build a local-first terminal collaboration room in which a human and independently authenticated Claude Code, Codex and Google Antigravity CLI agents can communicate, inspect the same project, debate decisions, implement changes and review evidence. The product is an orchestration runtime, not a new LLM, a terminal multiplexer, or three disconnected chat windows. The human remains the authority over scope, permissions and final changes.

**Core promise:** One repository, one visible conversation, multiple independent engineering agents, one human in control.

### Goals
- Launch from an existing Git repository with a single command; detect installed CLIs and use their supported authentication flows.
- Provide a unified streaming terminal interface with human messages, agent replies, tool activity, status and approval requests.
- Enable targeted agent-to-agent messaging, independent reviews, controlled implementation and bounded revision cycles.
- Persist room state and provider conversation identifiers locally; recover after cancellation or crashes.
- Enforce a single writer, protect the original workspace and make review claims traceable to actual diffs and test results.
- No mandatory new LLM API key, hosted service, account or separate model billing integration. Provider subscriptions, quotas, terms and headless availability still apply; do not assume unlimited or free access.

### Non-goals (MVP)
Cloud collaboration, browser UI, remote workers, arbitrary agent plugins, automated deployments, autonomous merges/pushes, parallel writers, model training, token billing estimates without provider evidence, and support for every terminal coding agent. No extraction of authentication credentials or circumvention of provider restrictions.

## 2. Users and jobs to be done

Primary user: a developer with two or more installed coding agents and a local repository. They want independent opinions before expensive changes, faster implementation with cross-model review, and a single place to intervene. Secondary user: a developer auditing unfamiliar code without allowing any modifications.

User stories:
- As owner, I can start a room, select roles and see which providers are available.
- I can address one agent or everyone, read their discussion, and redirect work mid-task.
- As implementer, an agent can request another agent's opinion and receive the reply in a subsequent turn.
- As reviewer, an agent can inspect a pinned revision, give evidence-backed findings and verify fixes without changing the project.
- As owner, I can reject a plan, approve a specific plan, cancel execution, and inspect changes before deciding whether to apply them.
- I can restart the application and resume the correct room and provider sessions without silently replaying actions.

## 3. Scope and priorities

| ID | Priority | Requirement |
|---|---|---|
| FR-01 | P0 | CLI detection, diagnostics, configuration and capability checks |
| FR-02 | P0 | Room creation, live TUI, @mentions, broadcast, history |
| FR-03 | P0 | Claude, Codex and Antigravity headless adapters |
| FR-04 | P0 | Deterministic scheduler with targeted messages and bounded turns |
| FR-05 | P0 | Discussion, implementation and audit workflows |
| FR-06 | P0 | Plan approval, single-writer isolation, immutable review snapshots |
| FR-07 | P0 | SQLite persistence, cancellation, restart recovery |
| FR-08 | P0 | Review findings, revision loop, diff and test evidence |
| FR-09 | P1 | Local MCP messaging tools and agent-initiated review requests |
| FR-10 | P1 | Explicitly enabled autonomous mode with limits and approval policy |
| FR-11 | P1 | Structured transcript export, configurable role templates |
| FR-12 | P2 | Persistent ACP/app-server transports, PTY fallback, additional providers |

P0 is the release gate. P1 features may ship only once P0 tests pass. P2 requires a separate design decision.

## 4. Experience and commands

Executable: `chayxona`. Initial distribution through local npm build; public npm publication is out of scope until name and package ownership are confirmed.

```sh
chayxona doctor
chayxona init
chayxona start --implementer claude --reviewer codex --architect antigravity
chayxona rooms
chayxona resume <room-id>
chayxona export <room-id> --format jsonl
```

`doctor` reports executable path, version, supported flags, authentication status (unknown when not verifiable), Git readiness, sandbox capabilities and actionable errors. It must not print credentials. A missing provider is disabled, not a fatal error when the requested workflow can run with the available agents. Start with at least two available agents for collaborative mode; allow one for diagnostics.

### TUI layout

```text
 CHAYXONA / backend / task-004                    DISCUSSION
 Claude: idle   Codex: thinking   Antigravity: idle
 ─────────────────────────────────────────────────────────
 YOU          Add cache-aside Redis support.
 CLAUDE       Proposed TTL and cache adapter design.
 CODEX        Finding: cache stampede risk on cold keys.
 ANTIGRAVITY  Suggest an explicit invalidation contract.
 SYSTEM       Plan v2 ready. Awaiting approval.
 ─────────────────────────────────────────────────────────
 Task: awaiting plan approval | turns 4/12 | changes: none
 > /approve plan-v2
```

Layout: room header, agent status line, scrollable transcript, optional details pane (diff, tool output, findings), task footer and multiline composer. Use agent labels in addition to colors. Support keyboard-only navigation, narrow terminals, plain output for non-TTY and no-color mode. Stream partial output without stealing composer focus; sanitize ANSI escape sequences, bound output and coalesce redraws. Display actual tool events separately from assistant prose; do not fabricate internal reasoning.

| Input | Behavior |
|---|---|
| `@claude <message>` | Queue a turn for Claude only |
| `@all <message>` | Deliver once to each active participant; no automatic infinite rebroadcast |
| unaddressed message | Publish to room and route to current task lead; if no task, prompt for recipient or use discussion policy |
| `/task <description>` | Create a task and begin planning |
| `/mode discussion|implementation|audit|autonomous` | Change mode at safe boundary; autonomous requires opt-in |
| `/role <agent> <role>` | Change role when no write operation is active; persist role revision |
| `/approve <id>` / `/reject <id> <reason>` | Resolve exactly one current approval |
| `/pause` / `/continue` | Stop scheduling new turns / resume scheduling |
| `/stop [agent|all]` | Cancel active process(es), mark interrupted, reconcile workspace |
| `/status`, `/history`, `/diff`, `/tests`, `/review` | Inspect persisted evidence and current state |
| `/apply <revision>` | Apply approved patch after checking original repo has not diverged |
| `/help`, `/quit` | Help / graceful exit; never implicitly approve or apply |

Human messages remain accepted while agents run. If mid-turn steering is unsupported, queue the message and display that it will be delivered after the active turn; cancellation is explicit. Ctrl-C first cancels active work; a subsequent explicit quit exits after cleanup.

## 5. Roles and collaboration rules

- **Owner (human):** sole authority for permissions, plan approval, scope changes, final application and overrides.
- **Implementer (default Claude):** proposes plan, edits only the assigned worktree, runs approved tests, reports changes, requests review and addresses findings.
- **Reviewer (default Codex):** independent read-only code and security review, evidence-backed findings, test-gap analysis.
- **Architect (default Antigravity):** independent design review, alternative approaches, integration and maintainability analysis; read-only by default.

Roles are independent of providers. Exactly one implementer may hold a write lease. Any agent can request an opinion, but cannot grant permissions, approve its own plan, impersonate the human or directly launch other provider CLIs. Role prompts are behavioral guidance, not a security boundary. Enforce privileges in orchestration and sandbox policy.

### Conversation scheduling
1. Persist incoming human or agent message with sender, recipients, task ID and correlation ID.
2. Enqueue only authorized recipients; exclude sender by default. A message may cause at most one scheduled turn per recipient.
3. Assemble context from task brief, role rules, current revision, targeted message, recent relevant history and prior decisions. Bound context and retain references to full transcript.
4. Run at most one turn per provider session and at most two independent read-only turns concurrently. Serialize all writers.
5. Stream normalized events, persist completion and process structured actions. Treat all agent output as untrusted.
6. Stop on approval, explicit completion, hard error, pause, cancellation, budget exhaustion or maximum rounds. No automatic retry of interrupted write turns.

Default configurable limits: 12 agent turns per task, 2 revision cycles, 10 minutes per turn, 45 minutes per task, 2 concurrent read-only turns, 1 writer. Limits are product defaults, not claims about provider quotas. Show remaining budget and allow the owner to explicitly extend it.

## 6. Task lifecycle

```text
CREATED -> PLANNING -> AWAITING_PLAN_APPROVAL
                       | reject -> PLANNING (new version)
                       | approve
                       v
                    IMPLEMENTING -> VERIFYING -> REVIEWING
                         ^                         |
                         | blocking findings <-----+
                         | (bounded revision)      | passed
                                                   v
                                  AWAITING_FINAL_APPROVAL
                                                   |
                                     approve -> READY_TO_APPLY
                                                   |
                                     explicit apply -> COMPLETED
```

Any active phase can transition to PAUSED, INTERRUPTED, FAILED or CANCELLED as appropriate. Resume uses the last durable checkpoint, never assumes a provider turn completed. Audit and discussion modes terminate in a report without write approval or patch application. A final approval is bound to the exact revision, plan version and evidence manifest; changes invalidate it. Rejected final output returns to review/planning as directed. A blocked task requires human intervention.

### Workflow behavior
- **Discussion:** targeted or broadcast conversation; no repository writes or shell execution beyond explicitly approved read operations. Produce decision summary and open questions.
- **Implementation:** gather independent proposals; lead synthesizes plan with affected paths, risks, test plan and acceptance criteria. Wait for approval. Create worktree, obtain writer lease, implement, capture diff, run checks, release writer, pin review snapshot, gather independent findings, iterate if needed. Final application requires human action.
- **Audit:** all selected agents independently inspect same revision before seeing one another's conclusions; merge duplicate findings while preserving dissent. No edits.
- **Autonomous (P1):** explicit task-level opt-in; human can authorize bounded implementation/revision in advance, but destructive actions, scope changes, final application and deployment remain gated.

Review outcomes: PASS, PASS_WITH_NONBLOCKING_FINDINGS, CHANGES_REQUIRED, INCOMPLETE. Critical/high findings block by default; medium findings classified by reviewer and policy. An unavailable required reviewer results in INCOMPLETE, never automatic PASS. Override must be explicit, reasoned and logged; UI identifies unverified result.

## 7. Architecture

```text
Human <-> Ink TUI / Commander CLI
                |
         Application service
                |
  Room manager / Task FSM / Approval service
                |
  Scheduler <-> Event bus <-> SQLite event store
      |              |             |
  Adapter registry   |       Recovery / export
      |              |
  Claude / Codex / Antigravity subprocesses
      |              |
      +---- optional local MCP room server
      |
  Workspace manager / sandbox / Git / evidence runner
```

Use Node.js 22+ (verify dependency engine requirements), TypeScript strict, ESM, Ink/React, Commander, Zod, child_process or Execa, SQLite with Drizzle and a supported driver, Pino with redaction, Vitest. npm package manager; pin dependencies and lockfile. No network service or Redis required. Use a single local orchestrator process in MVP. Keep domain logic free from TUI and provider SDK dependencies.

### Suggested source layout

```text
src/
  cli/                 command entrypoints, doctor
  tui/                 screens, composer, transcript, status
  domain/              types, events, state machine, roles
  application/         room and task services, approvals
  orchestrator/        scheduler, routing, context assembly
  adapters/            contract, claude, codex, antigravity, fake
  workspace/           Git worktrees, leases, sandbox, evidence
  persistence/         schema, migrations, repositories
  protocol/            action validation, optional MCP server
  security/            policies, redaction, authorization
  config/              validation, defaults
  observability/       logs, diagnostics
 tests/                unit, fixtures, integration, e2e
 docs/                 architecture, provider compatibility, security
```

Dependency direction: TUI/CLI -> application -> domain; adapters and persistence implement application ports; infrastructure never dictates domain transitions. Inject clock, ID generator and process runner for deterministic tests.

## 8. Provider integrations

### Adapter interface (proposed)

```ts
interface AgentAdapter {
  id: 'claude' | 'codex' | 'antigravity';
  probe(): Promise<ProviderCapabilities>;
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
interface TurnInput {
  roomId: string; taskId: string; turnId: string;
  providerSessionId?: string;
  cwd: string; prompt: string;
  permissions: 'read-only' | 'workspace-write';
  timeoutMs: number;
}
```

Probe binary version and help, identify supported noninteractive output and resume features. Keep raw provider-specific fields isolated inside adapters. Events: `turn.started`, `session.bound`, `text.delta`, `text.completed`, `tool.started`, `tool.completed`, `usage.reported`, `approval.required`, `turn.completed`, `turn.failed`, `turn.cancelled`, `provider.warning`. Each includes room/task/turn/agent IDs, monotonic local sequence, timestamp and validated payload. Usage fields nullable; missing metadata is unknown, not zero. Handle unknown provider events without crashing; log redacted diagnostic.

### Initial transport: subprocess per turn

Candidate commands, to validate against locally installed versions before enabling:

```sh
claude -p '<prompt>' --output-format stream-json --verbose
claude -p '<prompt>' --resume '<session-id>' --output-format stream-json --verbose
codex exec --json --sandbox read-only '<prompt>'
codex exec resume '<session-id>' --json '<prompt>'
agy -p '<prompt>' --output-format stream-json
agy -p '<prompt>' --conversation '<conversation-id>' --output-format stream-json
```

These are transport examples, NOT complete safe invocation profiles. Build argument arrays without shell interpolation; prefer stdin where officially supported, and avoid prompt text in process arguments when possible. Verify resume syntax, permission flags, working-directory semantics and authenticated headless use in each installed version. If a resumed invocation cannot enforce the same permission level, disable resume for that role and reconstruct bounded context in a fresh session. Never use bypass-permission flags or automatic provider permission escalation. Do not use global last-session shortcuts; bind exact IDs per room/agent/workspace/role permission epoch.

Claude: parse documented stream events and session IDs; select verified tool permissions. Codex: parse JSONL thread/item/turn events and sandbox options. Antigravity: parse documented streaming events and conversation ID, distinguish structured stderr errors and timeouts. Antigravity also documents `agy acp` in newer versions; evaluate ACP as a later persistent transport for richer steering and cancellation rather than requiring it for MVP.

### Process runner
- Resolve executable from trusted config/PATH; spawn with `shell: false` and explicit cwd. Do not evaluate model-supplied shell strings in the orchestrator.
- Handle partial lines, split UTF-8 sequences, CRLF, malformed/oversized records, stderr, exit codes and missing final events. Cap line size and retained logs; mark truncation explicitly.
- Separate stdout protocol from stderr diagnostics. Preserve sequence per stream; do not invent cross-stream ordering.
- On cancellation: stop new scheduling, send graceful termination, escalate after configurable grace, reap descendants using OS-appropriate process groups. Test orphan handling. Mark writes interrupted and inspect changes.
- Map errors to auth_required, quota, unsupported_version, permission_denied, timeout, protocol_error, process_exit, cancelled, unknown. Retry only provably safe pre-execution or read-only transient errors, with capped backoff and visible status; never replay a write automatically.
- Use vendor-supported local authentication and respect terms. Do not copy token stores or request credentials through room chat. If unavailable, instruct the human to authenticate using the official CLI.

## 9. Agent messaging protocol

P0 must work without MCP: ask agents to produce a final structured action envelope alongside readable messages. Prefer native output schema when supported; otherwise parse a delimited JSON block only from the final assistant message, not tool output. Validate with Zod; never execute an invalid envelope; surface it and allow one bounded repair turn. Action types: send_message, request_review, propose_plan, report_findings, report_completion, no_action. Human-readable text remains visible even if the envelope is invalid.

```json
{
  "version": 1,
  "actions": [{
    "type": "send_message",
    "to": ["codex"],
    "body": "Check whether this cache invalidation design races.",
    "replyRequested": true
  }]
}
```

The runtime stamps sender, task, timestamp and IDs from trusted context; ignore attempted identity or approval overrides. Limit recipients, message size, actions per turn and fan-out. Deduplicate using turn ID and action index. Never allow arbitrary destination paths or executable names in an action. Agent replies are routed as new turns; do not block an active MCP call waiting for another agent to finish.

### MCP extension (P1)

Expose local tools `room_send_message`, `room_broadcast`, `room_get_messages`, `room_get_task`, `room_list_agents`, `room_request_review`, `room_request_approval`, `room_report_completion`. Use official MCP SDK and provider-supported registration. Prefer stdio bridge with authenticated local IPC to orchestrator; no public listener. Each bridge receives short-lived scoped identity from runtime; derive sender from connection, not arguments. Return acknowledgement/message ID immediately; reply arrives in a subsequent scheduled turn. Enforce identical routing, permissions, dedupe and budgets as native envelope. Never expose approve, apply, shell or privilege escalation as agent tools. Disable MCP when provider support cannot be verified.

## 10. Workspace and security model

The original repository remains untouched until explicit apply. For MVP require a clean Git working tree and valid HEAD before implementation; refuse dirty repos with remediation guidance rather than stashing or deleting user changes. Discussion can run without creating a worktree; audit pins a committed revision.

1. Record base commit, original repo identity, task ID and approved plan hash. Create dedicated worktree/branch in private local state directory.
2. Acquire exclusive writer lease (transaction + OS/process lock). Enforce allowed workspace paths and deny unrelated files, secrets, credential stores, deployment tools and unapproved network operations where supported.
3. Provider sandbox plus OS isolation is required for enforcement. A worktree or role prompt alone does not prevent writes outside it. If strict read-only or required isolation is unavailable on the current OS/provider, refuse that execution profile and explain limitations; do not silently fall back to unrestricted access. Start macOS as primary target, Linux next; verify platform sandbox behavior in Phase 0.
4. At verification, capture tracked/untracked changes, reject unsafe symlinks/path escapes, generate an immutable revision and content hash. Review agents see the same pinned read-only snapshot, not an actively changing writer directory. Keep writer inactive during reviews.
5. Run configured test commands with explicit allowlist, bounded runtime and sandbox policy; record command, exit code, duration and output excerpt. Repository scripts are untrusted code. Never run unapproved installation, deployment or network commands automatically.
6. Before apply, verify final approval hash, review revision and current original HEAD/status. Show diff; apply only on explicit human command, fail safely on divergence/conflicts. No force reset, push, merge or overwrite. Leave original unchanged on failed preflight. Retain worktree until user requests cleanup; cleanup only app-owned paths and never delete uncommitted work without confirmation.

Security: treat repository instructions, provider responses, tool output and agent-to-agent messages as untrusted data; they cannot change runtime policies. Prevent path traversal, command injection, terminal escape injection, cross-room message leakage and secret logging. Use restrictive state directory permissions, redact common tokens and environment secrets, never store full environment dumps. Provider context may be transmitted to external vendors; show consent/notice at room start, use repository exclusion rules, and avoid claiming local-first means inference is local. Exclusions are not a guarantee if provider tools can independently read files; sandbox access accordingly. No telemetry by default.

## 11. Persistence and recovery

SQLite database under OS-appropriate private user data directory; use WAL, foreign keys, migrations and transactions. Tables:

| Table | Key fields |
|---|---|
| rooms | id, repo_path, created_at, status, mode, config_json |
| agents | room_id, agent_id, provider, role, permission_epoch, status |
| provider_sessions | room_id, agent_id, workspace_id, permission_epoch, external_id |
| tasks | id, room_id, state, base_sha, active_revision, limits, version |
| turns | id, task_id, agent_id, status, started_at, ended_at, error_code |
| messages | id, room_id, task_id, turn_id, sender, recipients, body, seq |
| events | seq, room_id, task_id, turn_id, type, payload_json, created_at |
| approvals | id, task_id, kind, subject_hash, state, actor, reason |
| revisions | id, task_id, base_sha, snapshot_sha, diff_hash, worktree_path |
| findings | id, revision_id, reviewer, severity, path, line, evidence, state |
| checks | id, revision_id, command, exit_code, duration, log_ref |
| jobs | id, task_id, recipient, action_key, status, attempt |

Unique constraints on action dedupe keys, room sequence and active writer lease. Store state transition and related event/job atomically. Persist important events before scheduling subsequent actions; buffer text deltas for performance, flush on completion. After restart, stale RUNNING turns become INTERRUPTED; never claim success from partial output. Reconcile worktrees and process locks before releasing writer lease. Reopen room with history and explicit recovery choices: inspect, retry read-only, resume compatible provider session, or start new turn after human approval. Provide JSONL export and optional Markdown transcript; redact secrets and exclude raw logs by default.

## 12. Configuration

```json
{
  "version": 1,
  "agents": {
    "claude": {"enabled": true, "command": "claude", "role": "implementer"},
    "codex": {"enabled": true, "command": "codex", "role": "reviewer"},
    "antigravity": {"enabled": true, "command": "agy", "role": "architect"}
  },
  "limits": {"maxTurns": 12, "maxRevisions": 2, "turnTimeoutMs": 600000,
    "taskTimeoutMs": 2700000, "maxConcurrentReaders": 2},
  "policy": {"requirePlanApproval": true, "requireFinalApproval": true,
    "requiredReviewers": ["codex", "antigravity"], "allowNetworkTools": false},
  "checks": [],
  "exclude": [".env*", "*.pem", "*.key"]
}
```

Config precedence: safe compiled defaults -> user config -> trusted project config -> explicit CLI options. Repository config cannot weaken safety policy without explicit user confirmation; reject unknown schema keys and invalid role combinations. Keep secrets out of config. Document vendor-required network access separately from optional agent network tools.

## 13. Quality attributes and success metrics

Targets measured on local fixture, excluding provider/network latency: startup under 2 seconds after config load (doctor probes may run separately); input remains responsive during streams; first normalized output displayed within 250 ms of receiving it; no unbounded transcript memory growth (windowed view, paginated reads); graceful cancellation initiated within 1 second. Cap log size and use retention controls. These are engineering targets to measure, not guaranteed provider performance.

Release indicators: all three adapters pass fixture contracts; real smoke test for each locally authenticated provider; 100% of approval-gated transitions tested; no unauthorized write in adversarial isolation tests; correct recovery after forced process termination; complete three-agent task from plan to approved patch in a fixture repository. Report actual measured results and limitations. No fabricated usage or review metrics.

## 14. Test strategy and acceptance criteria

| ID | Scenario | Expected result |
|---|---|---|
| AC-01 | One CLI missing | Doctor identifies it; available agents still usable in compatible room |
| AC-02 | Split/malformed JSONL and unknown event | Valid events continue; diagnostics visible; no crash |
| AC-03 | @mention or duplicate action | Only intended recipient receives one turn |
| AC-04 | Human rejects plan | No writer lease or mutation; new plan revision required |
| AC-05 | Approved plan | Exactly one writer starts in dedicated worktree |
| AC-06 | Reviewer attempts write or path escape | Enforcement denies it; event logged; no original mutation |
| AC-07 | Reviewer identifies blocking issue | Task returns to implementer; review repeated on new revision |
| AC-08 | Required reviewer fails | Review incomplete; no automatic approval |
| AC-09 | Agent message claims human approved | Ignored as unauthorized; state unchanged |
| AC-10 | Turn/revision budget exceeded | Scheduling stops and asks owner for decision |
| AC-11 | User cancels active write | Process tree stopped; task interrupted; diff preserved |
| AC-12 | Crash/restart | Correct room restored; no duplicate actions or write replay |
| AC-13 | Original branch diverges | Apply refused; original untouched |
| AC-14 | Revision changes after approval | Old approval invalid; new review/approval required |
| AC-15 | Export and logs with fake secret | Secret redacted; no credentials exposed |
| AC-16 | Three real providers, safe fixture | Messages visible, review returned, session IDs tracked where supported |
| AC-17 | Human input while streaming | Composer responsive; message queued or supported steering shown |
| AC-18 | Repo content contains malicious instructions | No privilege elevation, shell injection or cross-room routing |

Unit: FSM transitions, routing, budgets, approval binding, permissions, adapters, Zod schemas, redaction. Integration: fake CLI executables, real SQLite, temp Git repos, process cancellation, sandbox adversarial tests, MCP if enabled. E2E: fake providers deterministic full workflow, interactive TUI keyboard and resize tests, non-TTY CLI output. Live smoke suite opt-in only (`CHAYXONA_LIVE_TEST=1`), never in default CI or with production repository. No provider calls during ordinary unit tests. CI: typecheck, lint, unit/integration, build; macOS and Linux matrix where supported.

## 15. Implementation roadmap and gates

**Phase 0 — Feasibility spike:** inspect local binaries/help, verify headless login, structured output, IDs/resume, permissions, cancellation and OS isolation. Capture sanitized fixtures and compatibility matrix. Gate: demonstrate two-way Claude/Codex message exchange and Antigravity one-turn run, or explicitly document unavailable capability; no pretend adapters.

**Phase 1 — Core room:** scaffold TS CLI, domain types, fake provider, event store, scheduler, config and basic TUI. Gate: deterministic multi-agent chat, @mentions, budgets and restart tests pass with fakes.

**Phase 2 — Provider adapters:** implement each independently with recorded fixtures and common contract. Gate: all fixture tests pass; run opt-in real smoke only with owner permission and authenticated environment; mark untested providers accurately.

**Phase 3 — Engineering workflow:** implement Git manager, single-writer lease, sandbox policy, task FSM, plan approval, evidence collection, independent review and revision loops. Gate: adversarial permission tests and full fake-provider implementation workflow pass.

**Phase 4 — Hardening and release:** crash recovery, cancellation, export, diagnostics, docs, package build, UX polish. Gate: P0 acceptance matrix complete, known issues recorded, no unsafe fallback.

**Phase 5 — Extensions:** MCP agent tools, explicit autonomous mode, richer provider transports (Antigravity ACP, Codex app server, Claude supported streaming interface), role templates. Each extension must preserve P0 guarantees.

## 16. Instructions for Antigravity implementation agent

Read this entire PRD before changing code. Inspect the current repository and existing conventions. Do not overwrite unrelated files or scaffold a nested application if a suitable project already exists. First produce `docs/IMPLEMENTATION_PLAN.md`, `docs/PROVIDER_COMPATIBILITY.md`, `docs/SECURITY_MODEL.md` and `docs/TODO.md` with ordered, testable tasks and assumptions. Identify unresolved feasibility constraints before coding the adapters. Follow the roadmap in order; implement small verified vertical slices. Use fake provider fixtures before any paid/live calls. Do not silently substitute Gemini API for Antigravity CLI or other provider APIs for requested CLI subscriptions. No live invocation, deployment, package publishing or destructive Git operation without explicit owner authorization.

For each phase report files changed, commands/tests actually run, results, blocked items and next phase. Prefer simple deterministic implementation over speculative framework abstractions. Keep README updated with installation, authentication prerequisites, config, commands, workflow examples, security limitations and troubleshooting. If an assumption is wrong, document it and propose a safe alternative; do not hide missing capabilities.

Definition of done: buildable CLI, documented installation, tested provider adapters with capability detection, live room and task workflow, durable state, enforcement of safety gates, reproducible tests, acceptance matrix with evidence, no mandatory external API keys, and honest compatibility documentation. A mock-only implementation must be labeled as such.

## 17. Reference documentation and open decisions

Official documentation consulted for transport design (2026-11-24; validate installed versions):
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Codex CLI reference: https://learn.chatgpt.com/docs/cli/reference
- Antigravity headless mode: https://antigravity.google/docs/cli/headless/
- Antigravity CLI reference: https://antigravity.google/docs/cli/reference
- Antigravity changelog / ACP: https://antigravity.google/docs/changelog?tab=cli

Open decisions for Phase 0: exact sandbox mechanism per operating system; availability of supported subscription-backed headless sessions under each account; provider event schemas and resume behavior; dependency versions; whether ACP is worth prioritizing over MCP; package name availability. These are not blockers to implementing the fake-provider core, but are blockers to claiming production-ready multi-provider support.
