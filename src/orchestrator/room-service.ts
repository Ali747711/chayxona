import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../adapters/contract.js';
import { checkTurnBudget, type BudgetCheckResult } from '../domain/budget.js';
import { groupFindings, parseFindingsFromReply } from '../domain/findings.js';
import type {
  AdapterErrorCode,
  AgentEvent,
  AgentId,
  FindingRecord,
  MessagePhase,
  MessageRecord,
  RoomRecord,
  RoundKind,
  RoundRecord,
} from '../domain/types.js';
import type { ChayxonaDB } from '../persistence/db.js';
import { SecretRedactor } from '../security/redactor.js';
import { buildCrossExamR2Prompt, buildBlindR1Prompt, buildFreeformPrompt } from './context-builder.js';
import { buildAuditPayload, getTreeFingerprint, inspectRepo, type AuditMode } from './git-inspector.js';

/**
 * Round State Machine (Chayxona v1):
 *
 *  [idle] ──/debate|/audit──► [blind_r1] ──(all terminal & >=2 done & !cancelled)──► [revealed_pending_r2]
 *                               │   │                                                        │
 *                  (/stop all)  │   └──(<2 done)──► [failed_partial]            (/pause?)────┤
 *                               ▼                                                  │         ▼ (auto or /continue)
 *                          [cancelled] ◄────────────────(/stop all)────────────────┴──► [cross_exam_r2] ──► [done]
 */

export interface RoomStatusEvent {
  type: 'status' | 'warning' | 'error';
  text: string;
}

export interface RoomServiceEvents {
  agentEvent: [event: AgentEvent];
  messageCommitted: [msg: MessageRecord];
  roundUpdated: [round: RoundRecord];
  findingsUpdated: [findings: FindingRecord[]];
  notice: [notice: RoomStatusEvent];
}

export interface RunCommandResult {
  roundId: number;
  status: 'completed' | 'degraded' | 'failed' | 'cancelled' | 'paused';
  exitCode: 0 | 1 | 2;
  succeededAgents: AgentId[];
  failedAgents: AgentId[];
}

export class RoomService extends EventEmitter {
  private readonly activeControllers = new Map<AgentId, AbortController>();
  private activeRound: RoundRecord | null = null;
  private paused = false;
  private batchHalted = false;
  private inFlight = false;
  private pendingR2Context: { roundId: number; topic: string; participants: AgentId[] } | null = null;

  constructor(
    public readonly room: RoomRecord,
    private readonly db: ChayxonaDB,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    private readonly redactor: SecretRedactor,
  ) {
    super();
  }

  getActiveRound(): RoundRecord | null {
    return this.activeRound;
  }

  isRunning(): boolean {
    return this.inFlight || this.activeControllers.size > 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getBudgetStatus(required = 0): BudgetCheckResult {
    const used = this.db.countRoomTurns(this.room.id);
    return checkTurnBudget(used, this.room.maxTurns, required);
  }

  extendBudget(delta: number): number {
    const nextMax = this.db.extendRoomBudget(this.room.id, delta);
    this.room.maxTurns = nextMax;
    this.emitNotice('status', `Room turn budget extended by +${delta} (new max: ${nextMax}).`);
    return nextMax;
  }

  pause(): void {
    this.paused = true;
    if (this.activeRound && this.activeRound.phase === 'blind_r1') {
      this.db.updateRound(this.room.id, this.activeRound.id, { pausedAfterR1: true });
      this.activeRound.pausedAfterR1 = true;
      this.emitNotice('status', 'Paused: Blind Round 1 will finish and reveal, then pause before Cross-Exam R2.');
    } else {
      this.emitNotice('status', 'Scheduling paused. Use /continue to resume.');
    }
  }

  async continueScheduling(): Promise<RunCommandResult | null> {
    if (this.isRunning()) {
      throw new Error('Cannot /continue while another round is running.');
    }
    this.paused = false;
    if (this.pendingR2Context) {
      const ctx = this.pendingR2Context;
      const budget = this.getBudgetStatus(ctx.participants.length);
      if (!budget.ok) {
        throw new Error(
          `Insufficient room turn budget (${budget.remaining} remaining, need ${ctx.participants.length}). Run /budget +12 to extend.`,
        );
      }
      this.pendingR2Context = null;
      this.emitNotice('status', `Resuming Cross-Exam Round 2 for round #${ctx.roundId}...`);
      return this.runCrossExamR2(ctx.roundId, ctx.topic, ctx.participants);
    }
    this.emitNotice('status', 'Scheduling resumed.');
    return null;
  }

  /**
   * Queues a human steering note during Blind R1 (0 turns, persisted to SQLite).
   */
  queueSteeringNote(body: string): MessageRecord {
    const roundId = this.activeRound?.id ?? (this.db.getLatestRound(this.room.id)?.id ?? 0);
    const msg = this.db.appendMessage({
      id: randomUUID(),
      roomId: this.room.id,
      turnId: null,
      roundId,
      roundPhase: 'steering',
      sender: 'human',
      recipients: this.room.agents,
      body: this.redactor.redact(body),
      sealed: false,
      createdAt: Date.now(),
    });
    this.emitNotice('status', 'Queued steering note for Cross-Exam Round 2.');
    return msg;
  }

  /**
   * Stops active turns. When stopping all, marks the active round cancelled BEFORE
   * aborting subprocesses so Blind R1 completion never auto-launches Cross-Exam R2.
   */
  stop(target: AgentId | 'all' = 'all'): void {
    if (target === 'all') {
      this.batchHalted = true;
      if (this.activeRound) {
        this.db.updateRound(this.room.id, this.activeRound.id, {
          cancelled: true,
          phase: 'cancelled',
        });
        this.activeRound.cancelled = true;
        this.activeRound.phase = 'cancelled';
        this.emit('roundUpdated', this.activeRound);
      }
      this.pendingR2Context = null;
      for (const controller of this.activeControllers.values()) {
        controller.abort();
      }
      this.emitNotice('warning', 'Stopping all active turns...');
      return;
    }

    const ctrl = this.activeControllers.get(target);
    if (ctrl) {
      ctrl.abort();
      this.emitNotice('warning', `Stopping ${target}...`);
    } else {
      this.emitNotice('status', `${target} is not currently running.`);
    }
  }

  /**
   * Ctrl+U / /unseal: during Blind R1, once >= 2 takes are done, atomically interrupts
   * still-running stragglers so Blind R1 reveals and proceeds to Cross-Exam R2.
   */
  unsealStraggler(): boolean {
    if (!this.activeRound || this.activeRound.phase !== 'blind_r1') {
      this.emitNotice('warning', 'Nothing to unseal — no Blind Round 1 is active.');
      return false;
    }
    const turns = this.db.listRoundTurns(this.room.id, this.activeRound.id, 'blind_r1');
    const doneCount = turns.filter((t) => t.status === 'done').length;
    if (doneCount < 2) {
      this.emitNotice('warning', `Need at least 2 completed takes before unsealing (currently ${doneCount}).`);
      return false;
    }
    this.batchHalted = true;
    let interruptedAny = false;
    for (const [agentId, ctrl] of this.activeControllers.entries()) {
      ctrl.abort();
      interruptedAny = true;
      this.emitNotice('warning', `Interrupted straggler ${agentId} to unseal Round 1.`);
    }
    return interruptedAny;
  }

  /**
   * Runs a full Blind Round 1 -> Cross-Exam Round 2 debate or audit.
   */
  async runDebateOrAudit(kind: 'debate' | 'audit', topic: string, auditMode?: AuditMode): Promise<RunCommandResult> {
    if (this.isRunning()) {
      throw new Error('Another round is already running. Wait for completion or run /stop.');
    }
    this.pendingR2Context = null;

    const activeAgents = this.room.agents.filter((a) => this.adapters.has(a));
    if (activeAgents.length === 0) {
      throw new Error('No available agent adapters configured for this room.');
    }
    if (!this.room.solo && activeAgents.length < 2) {
      throw new Error('Collaborative mode requires at least 2 available agents (or pass --solo).');
    }

    const requiredTurns = this.room.solo ? 1 : activeAgents.length * 2;
    const budget = this.getBudgetStatus(requiredTurns);
    if (!budget.ok) {
      throw new Error(
        `Insufficient room turn budget (${budget.remaining} remaining, need ${requiredTurns}). Run /budget +12 to extend.`,
      );
    }

    const repoInfo = inspectRepo(this.room.repoPath);
    const preFingerprint = repoInfo.isGitRepo ? repoInfo.statusPorcelain : '';
    const auditPayload = kind === 'audit' ? buildAuditPayload(repoInfo, auditMode, this.redactor) : undefined;
    if (auditPayload?.empty) {
      this.emitNotice('warning', `Audit target (${auditPayload.mode}) has no diff/untracked changes.`);
    }

    const round = this.db.createRound(this.room.id, kind, topic || `audit:${auditPayload?.mode ?? 'diff'}`, 'blind_r1');
    this.activeRound = round;
    this.emit('roundUpdated', round);

    const humanMsg = this.db.appendMessage({
      id: randomUUID(),
      roomId: this.room.id,
      turnId: null,
      roundId: round.id,
      roundPhase: 'freeform',
      sender: 'human',
      recipients: activeAgents,
      body: this.redactor.redact(kind === 'audit' ? `/audit ${auditMode ?? ''} ${topic}`.trim() : `/debate ${topic}`),
      sealed: false,
      createdAt: Date.now(),
    });
    this.emit('messageCommitted', humanMsg);

    const recentHistory = this.db.listMessages(this.room.id, { includeSealed: false, limit: 12 });

    // --- BLIND ROUND 1 (concurrent, sealed) ---
    const r1Results = await this.runConcurrentTurns(
      activeAgents,
      round.id,
      'blind_r1',
      true, // sealed!
      (agentId) =>
        buildBlindR1Prompt({
          agentId,
          kind,
          topic,
          audit: auditPayload,
          recentHistory,
        }),
    );

    // Check cancellation race (Codex catch #7)
    const freshRound = this.db.getRound(this.room.id, round.id);
    if (!freshRound || freshRound.cancelled) {
      this.activeRound = null;
      return {
        roundId: round.id,
        status: 'cancelled',
        exitCode: 1,
        succeededAgents: r1Results.succeeded,
        failedAgents: r1Results.failed,
      };
    }

    // Reveal completed Blind R1 takes atomically
    const revealed = this.db.unsealRoundMessages(this.room.id, round.id);
    for (const msg of revealed) {
      if (msg.roundPhase === 'blind_r1') {
        this.emit('messageCommitted', msg);
      }
    }
    this.emit('findingsUpdated', this.db.listVisibleFindings(this.room.id));

    // Check repo drift between R1 and R2
    if (repoInfo.isGitRepo) {
      const postR1Fingerprint = getTreeFingerprint(this.room.repoPath);
      if (postR1Fingerprint !== preFingerprint) {
        this.emitNotice('warning', 'Working tree changed during Round 1 (repo drift detected).');
      }
    }

    // Solo mode skips R2
    if (this.room.solo) {
      this.db.updateRound(this.room.id, round.id, { phase: 'done' });
      this.activeRound = null;
      this.emitNotice('status', 'Solo mode: Round 1 complete (Cross-Exam Round 2 skipped).');
      return {
        roundId: round.id,
        status: r1Results.succeeded.length > 0 ? 'completed' : 'failed',
        exitCode: r1Results.succeeded.length > 0 ? 0 : 1,
        succeededAgents: r1Results.succeeded,
        failedAgents: r1Results.failed,
      };
    }

    if (r1Results.succeeded.length < 2) {
      this.db.updateRound(this.room.id, round.id, { phase: 'failed_partial' });
      this.activeRound = null;
      this.emitNotice(
        'error',
        `Blind Round 1 finished with only ${r1Results.succeeded.length} successful agent(s); need >= 2 for Cross-Exam R2.`,
      );
      return {
        roundId: round.id,
        status: 'failed',
        exitCode: 1,
        succeededAgents: r1Results.succeeded,
        failedAgents: r1Results.failed,
      };
    }

    // Transition to revealed_pending_r2 (closes crash-after-reveal recovery gap)
    this.db.updateRound(this.room.id, round.id, { phase: 'revealed_pending_r2' });
    this.activeRound = this.db.getRound(this.room.id, round.id);
    if (this.activeRound) this.emit('roundUpdated', this.activeRound);

    if (this.paused || freshRound.pausedAfterR1) {
      this.pendingR2Context = { roundId: round.id, topic, participants: r1Results.succeeded };
      this.emitNotice('status', 'Round 1 revealed and paused before Cross-Exam R2. Run /continue to proceed.');
      return {
        roundId: round.id,
        status: 'paused',
        exitCode: 0,
        succeededAgents: r1Results.succeeded,
        failedAgents: r1Results.failed,
      };
    }

    const r2Result = await this.runCrossExamR2(round.id, topic, r1Results.succeeded);
    const hadAnyFailure = r1Results.failed.length > 0 || r2Result.failedAgents.length > 0;
    if (r2Result.status === 'completed' && hadAnyFailure) {
      return {
        ...r2Result,
        status: 'degraded',
        exitCode: 2,
        failedAgents: [...new Set([...r1Results.failed, ...r2Result.failedAgents])],
      };
    }
    return r2Result;
  }

  async runCrossExamR2(roundId: number, topic: string, participants: AgentId[]): Promise<RunCommandResult> {
    this.db.updateRound(this.room.id, roundId, { phase: 'cross_exam_r2' });
    this.activeRound = this.db.getRound(this.room.id, roundId);
    if (this.activeRound) this.emit('roundUpdated', this.activeRound);

    const r1Messages = this.db.listMessages(this.room.id, {
      roundId,
      roundPhase: 'blind_r1',
      includeSealed: false,
    });
    const r1Findings = this.db.listVisibleFindings(this.room.id, { roundId });
    const steeringNotes = this.db.listMessages(this.room.id, {
      roundId,
      roundPhase: 'steering',
      includeSealed: false,
    });

    const r2Results = await this.runConcurrentTurns(
      participants,
      roundId,
      'cross_exam_r2',
      false,
      (agentId) =>
        buildCrossExamR2Prompt({
          agentId,
          roundId,
          topic,
          r1Messages,
          r1Findings,
          steeringNotes,
        }),
    );

    const freshRound = this.db.getRound(this.room.id, roundId);
    if (!freshRound || freshRound.cancelled) {
      this.activeRound = null;
      return {
        roundId,
        status: 'cancelled',
        exitCode: 1,
        succeededAgents: r2Results.succeeded,
        failedAgents: r2Results.failed,
      };
    }

    this.db.updateRound(this.room.id, roundId, { phase: 'done' });
    this.activeRound = null;
    this.emit('findingsUpdated', this.db.listVisibleFindings(this.room.id));

    const allOk = r2Results.failed.length === 0;
    const anyOk = r2Results.succeeded.length > 0;
    return {
      roundId,
      status: allOk ? 'completed' : anyOk ? 'degraded' : 'failed',
      exitCode: allOk ? 0 : anyOk ? 2 : 1,
      succeededAgents: r2Results.succeeded,
      failedAgents: r2Results.failed,
    };
  }

  /**
   * Freeform targeted (@claude) or broadcast (@all / plain text when idle).
   */
  async runFreeform(recipients: AgentId[], message: string): Promise<RunCommandResult> {
    if (this.isRunning()) {
      throw new Error('Another turn is already running. Wait or run /stop.');
    }
    this.pendingR2Context = null;
    const activeTargets = recipients.filter((a) => this.adapters.has(a));
    if (activeTargets.length === 0) {
      throw new Error('None of the requested agents are available.');
    }

    const budget = this.getBudgetStatus(activeTargets.length);
    if (!budget.ok) {
      throw new Error(
        `Insufficient room turn budget (${budget.remaining} remaining, need ${activeTargets.length}). Run /budget +12 to extend.`,
      );
    }

    const round = this.db.createRound(this.room.id, 'freeform', message.slice(0, 80), 'freeform');
    this.activeRound = round;
    this.emit('roundUpdated', round);

    const humanMsg = this.db.appendMessage({
      id: randomUUID(),
      roomId: this.room.id,
      turnId: null,
      roundId: round.id,
      roundPhase: 'freeform',
      sender: 'human',
      recipients: activeTargets,
      body: this.redactor.redact(message),
      sealed: false,
      createdAt: Date.now(),
    });
    this.emit('messageCommitted', humanMsg);

    const recentHistory = this.db.listMessages(this.room.id, { includeSealed: false, limit: 12 });
    const res = await this.runConcurrentTurns(
      activeTargets,
      round.id,
      'freeform',
      false,
      (agentId) =>
        buildFreeformPrompt({
          agentId,
          humanMessage: message,
          recentHistory,
        }),
    );

    const freshRound = this.db.getRound(this.room.id, round.id);
    if (!freshRound || freshRound.cancelled) {
      this.activeRound = null;
      return {
        roundId: round.id,
        status: 'cancelled',
        exitCode: 1,
        succeededAgents: res.succeeded,
        failedAgents: res.failed,
      };
    }

    this.db.updateRound(this.room.id, round.id, { phase: 'done' });
    this.activeRound = null;
    this.emit('findingsUpdated', this.db.listVisibleFindings(this.room.id));

    return {
      roundId: round.id,
      status: res.failed.length === 0 ? 'completed' : res.succeeded.length > 0 ? 'degraded' : 'failed',
      exitCode: res.failed.length === 0 ? 0 : res.succeeded.length > 0 ? 2 : 1,
      succeededAgents: res.succeeded,
      failedAgents: res.failed,
    };
  }

  /**
   * Builds a deterministic, zero-LLM-cost local summary of findings and dissent.
   */
  buildLocalSummary(): string {
    const visibleMessages = this.db.listMessages(this.room.id, { includeSealed: false });
    const findings = this.db.listVisibleFindings(this.room.id);
    const grouped = groupFindings(findings);
    const dissents = findings.filter((f) => f.dissentsFrom.length > 0);

    const lines = [
      `## Room Summary (${this.room.id})`,
      `- Repo: ${this.room.repoPath}`,
      `- Turns used: ${this.db.countRoomTurns(this.room.id)}/${this.room.maxTurns}`,
      `- Visible messages: ${visibleMessages.length}`,
      `- Findings: ${findings.length} (${dissents.length} with explicit dissent)`,
    ];

    if (grouped.length > 0) {
      lines.push('\n### Findings by File');
      for (const g of grouped) {
        lines.push(`- **${g.group}**`);
        for (const f of g.items) {
          const linePart = f.line ? `:${f.line}` : '';
          const dissentPart = f.dissentsFrom.length > 0 ? ` [DISSENTS: ${f.dissentsFrom.join(', ')}]` : '';
          lines.push(`  - [${f.severity.toUpperCase()}] ${f.canonicalId}${linePart}: ${f.summary}${dissentPart}`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Exports redacted transcript + findings (strictly respecting the blind visibility gate).
   */
  exportRoom(format: 'md' | 'jsonl'): string {
    const messages = this.db.listMessages(this.room.id, { includeSealed: false });
    const findings = this.db.listVisibleFindings(this.room.id);
    const events = this.db.listVisibleEvents(this.room.id);

    if (format === 'jsonl') {
      const rows = [
        JSON.stringify({ type: 'room', room: this.room }),
        ...messages.map((m) => JSON.stringify({ type: 'message', message: m })),
        ...findings.map((f) => JSON.stringify({ type: 'finding', finding: f })),
        ...events.map((e) => JSON.stringify({ type: 'event', event: e })),
      ];
      return this.redactor.redact(rows.join('\n') + '\n');
    }

    const lines: string[] = [
      `# Chayxona Debate Transcript — ${this.room.id}`,
      '',
      `- **Repo:** \`${this.room.repoPath}\``,
      `- **Agents:** ${this.room.agents.join(', ')}`,
      `- **Mode:** READ-ONLY`,
      '',
      '## Transcript',
      '',
    ];

    for (const m of messages) {
      lines.push(`### ${m.sender.toUpperCase()} *(round ${m.roundId} · ${m.roundPhase})*`);
      lines.push('');
      lines.push(m.body);
      lines.push('');
    }

    lines.push(this.buildLocalSummary());
    return this.redactor.redact(lines.join('\n') + '\n');
  }

  private async runConcurrentTurns(
    agents: AgentId[],
    roundId: number,
    roundPhase: MessagePhase,
    sealed: boolean,
    promptFactory: (agentId: AgentId) => string,
  ): Promise<{ succeeded: AgentId[]; failed: AgentId[] }> {
    const succeeded: AgentId[] = [];
    const failed: AgentId[] = [];
    const concurrency = Math.max(1, Math.min(this.room.maxConcurrency, agents.length));
    const queue = [...agents];
    this.batchHalted = false;
    this.inFlight = true;

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !this.batchHalted) {
        const agentId = queue.shift();
        if (!agentId) break;
        const ok = await this.runSingleTurn(agentId, roundId, roundPhase, sealed, promptFactory(agentId));
        if (ok) succeeded.push(agentId);
        else failed.push(agentId);
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      // Mark any unstarted agents as failed when halted via /stop all or /unseal
      while (queue.length > 0) {
        const skipped = queue.shift();
        if (skipped) failed.push(skipped);
      }
    } finally {
      this.inFlight = false;
      this.batchHalted = false;
    }
    return { succeeded, failed };
  }

  private async runSingleTurn(
    agentId: AgentId,
    roundId: number,
    roundPhase: MessagePhase,
    sealed: boolean,
    prompt: string,
  ): Promise<boolean> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) return false;

    const turnId = randomUUID();
    const controller = new AbortController();
    this.activeControllers.set(agentId, controller);

    // Count turn at spawn so failing loops cannot bypass budget
    this.db.createTurn({
      id: turnId,
      roomId: this.room.id,
      roundId,
      roundPhase,
      agentId,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      errorCode: null,
    });

    const streamRedactor = this.redactor.createStreamRedactor(128);
    let finalRawText = '';
    let completed = false;
    let failedCode: AdapterErrorCode | null = null;
    let cancelled = false;

    try {
      for await (const rawEv of adapter.run(
        {
          roomId: this.room.id,
          roundId,
          turnId,
          agentId,
          cwd: this.room.repoPath,
          prompt,
          timeoutMs: this.room.turnTimeoutMs,
        },
        controller.signal,
      )) {
        // Apply adapter-boundary redaction before emitting or persisting
        if (rawEv.type === 'text.delta') {
          const safeDelta = streamRedactor.push(rawEv.delta);
          if (safeDelta && !sealed) {
            this.emit('agentEvent', { ...rawEv, delta: safeDelta });
          }
          continue;
        }

        if (rawEv.type === 'session.bound') {
          this.db.upsertProviderSession(this.room.id, agentId, rawEv.externalSessionId);
          this.emit('agentEvent', rawEv);
          continue;
        }

        if (rawEv.type === 'tool.started' || rawEv.type === 'tool.completed') {
          const safeSummary = this.redactor.redact(rawEv.summary).slice(0, 4096);
          const safeEv = { ...rawEv, summary: safeSummary };
          this.db.appendEvent(this.room.id, turnId, agentId, safeEv.type, {
            toolName: safeEv.toolName,
            summary: safeSummary,
            ok: safeEv.type === 'tool.completed' ? safeEv.ok : undefined,
          });
          // During blind_r1, emit tool name only (never payload) to prevent side-channel leaks
          this.emit('agentEvent', sealed ? { ...safeEv, summary: safeEv.toolName } : safeEv);
          continue;
        }

        if (rawEv.type === 'turn.completed') {
          const tail = streamRedactor.flush();
          if (tail && !sealed) {
            this.emit('agentEvent', {
              type: 'text.delta',
              roomId: this.room.id,
              roundId,
              turnId,
              agentId,
              delta: tail,
              ts: Date.now(),
            });
          }
          finalRawText = this.redactor.redact(rawEv.text);
          completed = true;
          this.emit('agentEvent', { ...rawEv, text: sealed ? '' : finalRawText });
          continue;
        }

        if (rawEv.type === 'turn.cancelled') {
          cancelled = true;
          this.emit('agentEvent', rawEv);
          continue;
        }

        if (rawEv.type === 'turn.failed') {
          failedCode = rawEv.errorCode;
          const safeMsg = this.redactor.redact(rawEv.message);
          this.db.appendEvent(this.room.id, turnId, agentId, 'turn.failed', {
            errorCode: rawEv.errorCode,
            message: safeMsg,
          });
          this.emit('agentEvent', { ...rawEv, message: safeMsg });
          continue;
        }

        this.emit('agentEvent', rawEv);
      }
    } catch (err) {
      failedCode = controller.signal.aborted ? 'cancelled' : 'unknown';
      const safeMsg = this.redactor.redact(err instanceof Error ? err.message : String(err));
      this.emitNotice('error', `${agentId} failed: ${safeMsg}`);
    } finally {
      if (this.activeControllers.get(agentId) === controller) {
        this.activeControllers.delete(agentId);
      }
    }

    if (!completed && (cancelled || controller.signal.aborted)) {
      this.db.finishTurn(turnId, 'interrupted', 'cancelled');
      return false;
    }

    if (!completed) {
      this.db.finishTurn(turnId, failedCode === 'timeout' ? 'timeout' : 'error', failedCode ?? 'unknown');
      return false;
    }

    const messageId = randomUUID();
    const findingPhase = roundPhase === 'blind_r1' ? 'r1' : roundPhase === 'cross_exam_r2' ? 'r2' : 'freeform';
    const knownIds = new Set(this.db.listVisibleFindings(this.room.id).map((f) => f.canonicalId));
    const parsed = parseFindingsFromReply({
      rawText: finalRawText,
      roomId: this.room.id,
      messageId,
      roundId,
      phase: findingPhase,
      agentId,
      knownCanonicalIds: knownIds,
    });

    for (const diag of parsed.diagnostics) {
      this.db.appendEvent(this.room.id, turnId, agentId, 'findings.diagnostic', { message: diag });
    }

    const msg = this.db.appendMessage({
      id: messageId,
      roomId: this.room.id,
      turnId,
      roundId,
      roundPhase,
      sender: agentId,
      recipients: ['human'],
      body: parsed.cleanProse,
      sealed,
      createdAt: Date.now(),
    });

    this.db.insertFindings(parsed.findings);
    this.db.finishTurn(turnId, 'done', null);

    if (!sealed) {
      this.emit('messageCommitted', msg);
      if (parsed.findings.length > 0) {
        this.emit('findingsUpdated', this.db.listVisibleFindings(this.room.id));
      }
    }

    return true;
  }

  private emitNotice(type: RoomStatusEvent['type'], text: string): void {
    this.emit('notice', { type, text });
  }
}
