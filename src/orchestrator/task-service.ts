import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../adapters/contract.js';
import { parseFindingsFromReply } from '../domain/findings.js';
import type {
  AgentId,
  ApprovalRecord,
  CheckRecord,
  FindingRecord,
  RevisionRecord,
  RoomRecord,
  TaskRecord,
} from '../domain/types.js';
import type { ChayxonaDB } from '../persistence/db.js';
import { SecretRedactor } from '../security/redactor.js';
import { runAllowlistedCheck } from '../workspace/check-runner.js';
import {
  applyApprovedRevision,
  assertCleanGitRepo,
  captureWorktreeRevision,
  createTaskWorktree,
  sha256,
  type WorktreeHandle,
} from '../workspace/worktree-manager.js';

/**
 * Human-Gated Task Lifecycle FSM (Chayxona v2):
 *
 *  CREATED -> PLANNING -> AWAITING_PLAN_APPROVAL
 *                           | reject -> PLANNING (planVersion + 1; no worktree/lease)
 *                           | approve
 *                           v
 *                       IMPLEMENTING (exclusive writer lease in isolated worktree)
 *                           | release lease
 *                           v
 *                        VERIFYING (immutable diffHash snapshot + allowlisted checks)
 *                           |
 *                           v
 *                        REVIEWING (strict read-only reviewers on pinned revision)
 *                           |--- blocking findings & rev < max -> IMPLEMENTING
 *                           |--- reviewer failed -> FAILED (never auto-PASS)
 *                           v (passed)
 *                  AWAITING_FINAL_APPROVAL (bound to exact revision.diffHash)
 *                           | approve
 *                           v
 *                     READY_TO_APPLY
 *                           | explicit /apply <revId> (checks baseSha & clean repo)
 *                           v
 *                       COMPLETED
 */

export interface TaskEventCallbacks {
  onStatus?: (text: string) => void;
}

export class TaskService {
  private readonly worktrees = new Map<string, WorktreeHandle>();

  constructor(
    private readonly room: RoomRecord,
    private readonly dataDir: string,
    private readonly db: ChayxonaDB,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    private readonly redactor: SecretRedactor,
    private readonly checkCommands: readonly string[] = [],
    private readonly callbacks: TaskEventCallbacks = {},
  ) {}

  getLatestTask(): TaskRecord | null {
    return this.db.getLatestTask(this.room.id);
  }

  getWorktreeHandle(taskId: string): WorktreeHandle | null {
    return this.worktrees.get(taskId) ?? null;
  }

  async startTask(
    description: string,
    opts: { implementer?: AgentId; maxRevisions?: number } = {},
  ): Promise<{ task: TaskRecord; approval: ApprovalRecord }> {
    const { baseSha } = assertCleanGitRepo(this.room.repoPath);
    const activeAgents = this.room.agents.filter((a) => this.adapters.has(a));
    if (activeAgents.length === 0) {
      throw new Error('No available agents to run /task.');
    }

    const implementer = opts.implementer && activeAgents.includes(opts.implementer)
      ? opts.implementer
      : activeAgents[0];
    const reviewers = activeAgents.filter((a) => a !== implementer);

    const now = Date.now();
    const task: TaskRecord = {
      id: `task-${randomUUID().slice(0, 8)}`,
      roomId: this.room.id,
      description,
      state: 'CREATED',
      implementer,
      reviewers,
      baseSha,
      planVersion: 0,
      planText: null,
      planHash: null,
      activeRevisionId: null,
      revisionCount: 0,
      maxRevisions: opts.maxRevisions ?? 2,
      createdAt: now,
      updatedAt: now,
    };
    this.db.createTask(task);
    return this.runPlanning(task.id, null);
  }

  private async runPlanning(
    taskId: string,
    rejectionReason: string | null,
  ): Promise<{ task: TaskRecord; approval: ApprovalRecord }> {
    let task = this.db.updateTask(taskId, { state: 'PLANNING' });
    this.emitStatus(`[${task.id}] PLANNING v${task.planVersion + 1} with ${task.implementer} (read-only)...`);

    const prompt = [
      `You are ${task.implementer.toUpperCase()} planning a task in READ-ONLY mode (do NOT edit files yet).`,
      `Task: ${task.description}`,
      rejectionReason ? `Previous plan was rejected by human: ${rejectionReason}\nProduce a revised plan.` : '',
      'Provide a concise implementation plan listing: affected files, key changes, risks, and verification steps.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const planText = await this.runAgentTurn(task.implementer, this.room.repoPath, prompt, 'read-only');
    const nextVersion = task.planVersion + 1;
    const planHash = sha256(planText);

    this.db.invalidateApprovals(task.id, 'plan');
    task = this.db.updateTask(task.id, {
      state: 'AWAITING_PLAN_APPROVAL',
      planVersion: nextVersion,
      planText,
      planHash,
    });

    const approval: ApprovalRecord = {
      id: `plan-${task.id.slice(-4)}-v${nextVersion}`,
      taskId: task.id,
      kind: 'plan',
      subjectHash: planHash,
      state: 'pending',
      actor: 'human',
      reason: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.db.createApproval(approval);
    this.emitStatus(
      `[${task.id}] Plan v${nextVersion} ready. Run \`/approve ${approval.id}\` or \`/reject ${approval.id} <reason>\`.`,
    );
    return { task, approval };
  }

  async rejectApproval(
    approvalId: string,
    reason: string,
  ): Promise<{ task: TaskRecord; nextApproval: ApprovalRecord }> {
    const existing = this.db.getApproval(approvalId);
    if (!existing) throw new Error(`Approval "${approvalId}" not found.`);
    this.db.resolveApproval(approvalId, 'rejected', reason);
    this.emitStatus(`[${existing.taskId}] Approval ${approvalId} rejected: ${reason}`);
    const next = await this.runPlanning(existing.taskId, reason);
    return { task: next.task, nextApproval: next.approval };
  }

  async approve(approvalId: string): Promise<{
    task: TaskRecord;
    revision?: RevisionRecord;
    checks?: CheckRecord[];
    findings?: FindingRecord[];
    finalApproval?: ApprovalRecord;
  }> {
    const approval = this.db.getApproval(approvalId);
    if (!approval) throw new Error(`Approval "${approvalId}" not found.`);
    const task = this.db.getTask(approval.taskId);
    if (!task) throw new Error(`Task "${approval.taskId}" not found.`);

    if (approval.kind === 'plan') {
      if (task.state !== 'AWAITING_PLAN_APPROVAL') {
        throw new Error(`Task ${task.id} is in state ${task.state}, not AWAITING_PLAN_APPROVAL.`);
      }
      if (approval.subjectHash !== task.planHash) {
        this.db.resolveApproval(approval.id, 'invalidated', 'Plan hash mismatch');
        throw new Error(`Plan approval ${approval.id} no longer matches current plan hash.`);
      }
      this.db.resolveApproval(approval.id, 'approved', null);
      return this.executeImplementationAndReviewLoop(task.id);
    }

    // kind === 'final'
    if (task.state !== 'AWAITING_FINAL_APPROVAL' || !task.activeRevisionId) {
      throw new Error(`Task ${task.id} is in state ${task.state}, not AWAITING_FINAL_APPROVAL.`);
    }
    const rev = this.db.getRevision(task.activeRevisionId);
    if (!rev || approval.subjectHash !== rev.diffHash) {
      this.db.resolveApproval(approval.id, 'invalidated', 'Revision changed after approval request');
      throw new Error(`Final approval ${approval.id} invalidated because revision changed.`);
    }
    this.db.resolveApproval(approval.id, 'approved', null);
    const updated = this.db.updateTask(task.id, { state: 'READY_TO_APPLY' });
    this.emitStatus(`[${task.id}] Approved! Run \`/apply ${rev.id}\` to apply patch to original repo.`);
    return { task: updated, revision: rev };
  }

  private async executeImplementationAndReviewLoop(taskId: string): Promise<{
    task: TaskRecord;
    revision?: RevisionRecord;
    checks?: CheckRecord[];
    findings?: FindingRecord[];
    finalApproval?: ApprovalRecord;
  }> {
    let task = this.db.getTask(taskId)!;
    let handle = this.worktrees.get(task.id);
    if (!handle) {
      handle = createTaskWorktree(this.dataDir, this.room.repoPath, this.room.id, task.id);
      this.worktrees.set(task.id, handle);
    }

    let blockingFeedback = '';

    while (true) {
      // 1. IMPLEMENTING (exclusive single-writer lease in isolated worktree)
      task = this.db.updateTask(task.id, { state: 'IMPLEMENTING' });
      this.emitStatus(
        `[${task.id}] IMPLEMENTING (rev ${task.revisionCount + 1}) with ${task.implementer} in isolated worktree...`,
      );

      this.db.acquireWriterLease(this.room.id, task.id, task.implementer, handle.worktreePath);
      try {
        const implPrompt = [
          `You are ${task.implementer.toUpperCase()} implementing an approved plan inside an isolated Git worktree.`,
          `Task: ${task.description}`,
          `Approved Plan (v${task.planVersion}):\n${task.planText ?? ''}`,
          blockingFeedback ? `Blocking review findings to fix:\n${blockingFeedback}` : '',
          'Make only the minimal clean changes needed inside this worktree.',
        ]
          .filter(Boolean)
          .join('\n\n');

        await this.runAgentTurn(task.implementer, handle.worktreePath, implPrompt, 'workspace-write');
      } finally {
        // Always release writer lease BEFORE verification & read-only review
        this.db.releaseWriterLease(this.room.id);
      }

      // 2. VERIFYING (immutable snapshot + allowlisted checks)
      task = this.db.updateTask(task.id, { state: 'VERIFYING' });
      const revision = captureWorktreeRevision(task.id, handle);
      this.db.createRevision(revision);
      // Any previous final approval is now invalid because a new revision was produced
      this.db.invalidateApprovals(task.id, 'final');

      task = this.db.updateTask(task.id, {
        activeRevisionId: revision.id,
        revisionCount: task.revisionCount + 1,
      });

      const checks: CheckRecord[] = [];
      for (const cmd of this.checkCommands) {
        const chk = await runAllowlistedCheck({
          revisionId: revision.id,
          worktreePath: handle.worktreePath,
          rawCommand: cmd,
          redactor: this.redactor,
        });
        this.db.insertCheck(chk);
        checks.push(chk);
      }

      // 3. REVIEWING (strict read-only reviewers against pinned revision)
      task = this.db.updateTask(task.id, { state: 'REVIEWING' });
      const allFindings: FindingRecord[] = [];
      let reviewerFailed = false;

      for (const reviewer of task.reviewers) {
        this.emitStatus(`[${task.id}] REVIEWING ${revision.id} with ${reviewer} (read-only)...`);
        const reviewPrompt = [
          `You are ${reviewer.toUpperCase()} performing a READ-ONLY code review of pinned revision ${revision.id}.`,
          `Task: ${task.description}`,
          `Diff:\n\`\`\`diff\n${this.redactor.redact(revision.diffPatch).slice(0, 32 * 1024)}\n\`\`\``,
          checks.length > 0
            ? `Checks:\n${checks.map((c) => `- ${c.command}: exit=${c.exitCode} (${c.durationMs}ms)`).join('\n')}`
            : '',
          'Report any blocking critical/high bugs in a fenced `chayxona-findings` JSON block.',
        ]
          .filter(Boolean)
          .join('\n\n');

        try {
          const reply = await this.runAgentTurn(reviewer, handle.worktreePath, reviewPrompt, 'read-only');
          const parsed = parseFindingsFromReply({
            rawText: reply,
            roomId: this.room.id,
            messageId: randomUUID(),
            roundId: task.revisionCount,
            phase: 'r1',
            agentId: reviewer,
            knownCanonicalIds: new Set(),
          });
          allFindings.push(...parsed.findings);
        } catch (err) {
          reviewerFailed = true;
          this.emitStatus(
            `[${task.id}] Required reviewer ${reviewer} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // AC-08: unavailable/failed required reviewer -> INCOMPLETE / FAILED, never automatic PASS
      if (reviewerFailed) {
        task = this.db.updateTask(task.id, { state: 'FAILED' });
        return { task, revision, checks, findings: allFindings };
      }

      const blocking = allFindings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      if (blocking.length > 0 && task.revisionCount < task.maxRevisions) {
        blockingFeedback = blocking
          .map((f) => `- [${f.severity.toUpperCase()}] ${f.file ?? 'General'}:${f.line ?? 0}: ${f.summary} (${f.evidence})`)
          .join('\n');
        this.emitStatus(
          `[${task.id}] ${blocking.length} blocking finding(s) on ${revision.id}; starting revision ${task.revisionCount + 1}/${task.maxRevisions}...`,
        );
        continue;
      }

      if (blocking.length > 0) {
        task = this.db.updateTask(task.id, { state: 'FAILED' });
        this.emitStatus(`[${task.id}] Revision budget exhausted (${task.revisionCount}/${task.maxRevisions}) with blocking findings.`);
        return { task, revision, checks, findings: allFindings };
      }

      // 4. Passed review -> AWAITING_FINAL_APPROVAL bound to exact revision.diffHash
      task = this.db.updateTask(task.id, { state: 'AWAITING_FINAL_APPROVAL' });
      const finalApproval: ApprovalRecord = {
        id: `final-${revision.id.slice(-4)}`,
        taskId: task.id,
        kind: 'final',
        subjectHash: revision.diffHash,
        state: 'pending',
        actor: 'human',
        reason: null,
        createdAt: Date.now(),
        resolvedAt: null,
      };
      this.db.createApproval(finalApproval);
      this.emitStatus(
        `[${task.id}] Review passed for ${revision.id}. Inspect with \`/diff\`, then run \`/approve ${finalApproval.id}\`.`,
      );
      return { task, revision, checks, findings: allFindings, finalApproval };
    }
  }

  /**
   * Explicitly applies an approved revision patch to the original repository.
   */
  applyRevision(revisionId: string): TaskRecord {
    const rev = this.db.getRevision(revisionId);
    if (!rev) throw new Error(`Revision "${revisionId}" not found.`);
    const task = this.db.getTask(rev.taskId);
    if (!task) throw new Error(`Task "${rev.taskId}" not found.`);

    if (task.state !== 'READY_TO_APPLY' || task.activeRevisionId !== rev.id) {
      throw new Error(`Task ${task.id} is not READY_TO_APPLY for revision ${rev.id} (state: ${task.state}).`);
    }

    const approved = this.db.findApprovedForSubject(task.id, 'final', rev.diffHash);
    if (!approved) {
      throw new Error(`No valid human final approval matching diffHash for revision ${rev.id}.`);
    }

    applyApprovedRevision(this.room.repoPath, rev);
    const done = this.db.updateTask(task.id, { state: 'COMPLETED' });
    this.emitStatus(`[${task.id}] Applied revision ${rev.id} cleanly to original repository. Task COMPLETED.`);
    return done;
  }

  private async runAgentTurn(
    agentId: AgentId,
    cwd: string,
    prompt: string,
    permissions: 'read-only' | 'workspace-write',
  ): Promise<string> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) throw new Error(`Adapter "${agentId}" not available.`);
    const ac = new AbortController();
    let finalText = '';
    let completed = false;
    let failMsg = '';

    for await (const ev of adapter.run(
      {
        roomId: this.room.id,
        roundId: 0,
        turnId: randomUUID(),
        agentId,
        cwd,
        prompt,
        timeoutMs: this.room.turnTimeoutMs,
        permissions,
      },
      ac.signal,
    )) {
      if (ev.type === 'turn.completed') {
        finalText = this.redactor.redact(ev.text);
        completed = true;
      } else if (ev.type === 'turn.failed') {
        failMsg = this.redactor.redact(ev.message);
      }
    }

    if (!completed) {
      throw new Error(failMsg || `${agentId} turn did not complete`);
    }
    return finalText;
  }

  private emitStatus(text: string): void {
    this.callbacks.onStatus?.(text);
  }
}
