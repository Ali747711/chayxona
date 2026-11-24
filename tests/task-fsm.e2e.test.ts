import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/contract.js';
import { FakeAgentAdapter } from '../src/adapters/fake.js';
import type { AgentId, RoomRecord } from '../src/domain/types.js';
import { TaskService } from '../src/orchestrator/task-service.js';
import { ChayxonaDB } from '../src/persistence/db.js';
import { SecretRedactor } from '../src/security/redactor.js';
import { cleanupTaskWorktree } from '../src/workspace/worktree-manager.js';

function makeCleanRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-task-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@chayxona.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'calc.ts'), 'export function add(a: number, b: number) { return a - b; }\n');
  execFileSync('git', ['add', 'calc.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('TaskService v2 E2E (Plan -> Approve -> Isolated Write -> Review Loop -> Apply)', () => {
  it('enforces AC-04 reject, AC-05 isolated writer, AC-06 read-only reviewer, AC-07 blocking revision loop, and /apply', async () => {
    const repo = makeCleanRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-task-data-'));
    const db = new ChayxonaDB(':memory:');
    const room: RoomRecord = {
      id: 'r-v2',
      repoPath: repo,
      baseSha: 'head',
      status: 'active',
      maxTurns: 24,
      agents: ['claude', 'codex'],
      solo: false,
      turnTimeoutMs: 5000,
      maxConcurrency: 3,
      createdAt: 1,
      updatedAt: 1,
    };
    db.createRoom(room);

    let implAttempt = 0;
    const seenPermissions: Array<{ agent: AgentId; perm: string }> = [];

    const adapters = new Map<AgentId, AgentAdapter>([
      [
        'claude',
        new FakeAgentAdapter('claude', (input) => {
          seenPermissions.push({ agent: 'claude', perm: input.permissions ?? 'read-only' });
          if (input.permissions === 'workspace-write') {
            implAttempt += 1;
            // Attempt 1 writes a buggy fix; attempt 2 fixes the blocking finding
            const content =
              implAttempt === 1
                ? 'export function add(a: number, b: number) { return a + b + 1; }\n'
                : 'export function add(a: number, b: number) { return a + b; }\n';
            fs.writeFileSync(path.join(input.cwd, 'calc.ts'), content);
            return { chunks: [`Implemented attempt ${implAttempt}`] };
          }
          return { chunks: ['Plan: fix add() in calc.ts'] };
        }),
      ],
      [
        'codex',
        new FakeAgentAdapter('codex', (input) => {
          seenPermissions.push({ agent: 'codex', perm: input.permissions ?? 'read-only' });
          // Blocking high finding on attempt 1; passes on attempt 2
          if (input.prompt.includes('a + b + 1')) {
            return {
              chunks: [
                'Blocking bug found.\n```chayxona-findings\n' +
                  JSON.stringify({
                    findings: [
                      {
                        id: 'F1',
                        severity: 'high',
                        file: 'calc.ts',
                        line: 1,
                        summary: 'Off-by-one (+ 1) in add()',
                        evidence: 'returns a + b + 1',
                      },
                    ],
                  }) +
                  '\n```',
              ],
            };
          }
          return { chunks: ['Looks good — no blocking issues.'] };
        }),
      ],
    ]);

    const taskSvc = new TaskService(room, dataDir, db, adapters, new SecretRedactor({}));

    try {
      // 1. Start task -> PLANNING (read-only) -> AWAITING_PLAN_APPROVAL
      const started = await taskSvc.startTask('Fix add() in calc.ts');
      expect(started.task.state).toBe('AWAITING_PLAN_APPROVAL');
      expect(started.task.planVersion).toBe(1);
      expect(db.getWriterLease(room.id)).toBeNull();

      // 2. AC-04: Reject plan v1 -> no worktree/lease, produces plan v2
      const rejected = await taskSvc.rejectApproval(started.approval.id, 'Also check edge cases');
      expect(rejected.task.planVersion).toBe(2);
      expect(taskSvc.getWorktreeHandle(started.task.id)).toBeNull();
      expect(db.getWriterLease(room.id)).toBeNull();

      // 3. AC-05 + AC-07: Approve plan v2 -> isolated worktree write -> rev 1 blocked -> rev 2 passes
      const afterImpl = await taskSvc.approve(rejected.nextApproval.id);
      expect(afterImpl.task.state).toBe('AWAITING_FINAL_APPROVAL');
      expect(afterImpl.task.revisionCount).toBe(2);
      expect(afterImpl.finalApproval).toBeDefined();
      expect(db.getWriterLease(room.id)).toBeNull(); // Lease released before review!

      // AC-06: Reviewer NEVER received workspace-write permission
      expect(seenPermissions.filter((p) => p.agent === 'codex').every((p) => p.perm === 'read-only')).toBe(true);
      // Original repo is STILL untouched before explicit /apply!
      expect(fs.readFileSync(path.join(repo, 'calc.ts'), 'utf8')).toContain('a - b');

      // 4. Approve final -> READY_TO_APPLY -> explicit /apply -> COMPLETED
      const ready = await taskSvc.approve(afterImpl.finalApproval!.id);
      expect(ready.task.state).toBe('READY_TO_APPLY');

      const completed = taskSvc.applyRevision(afterImpl.revision!.id);
      expect(completed.state).toBe('COMPLETED');
      expect(fs.readFileSync(path.join(repo, 'calc.ts'), 'utf8')).toContain('return a + b;');

      const handle = taskSvc.getWorktreeHandle(started.task.id);
      if (handle) cleanupTaskWorktree(dataDir, repo, handle);
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces AC-08: failed required reviewer results in FAILED, never automatic PASS', async () => {
    const repo = makeCleanRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-task-fail-'));
    const db = new ChayxonaDB(':memory:');
    const room: RoomRecord = {
      id: 'r-fail',
      repoPath: repo,
      baseSha: 'head',
      status: 'active',
      maxTurns: 24,
      agents: ['claude', 'codex'],
      solo: false,
      turnTimeoutMs: 5000,
      maxConcurrency: 3,
      createdAt: 1,
      updatedAt: 1,
    };
    db.createRoom(room);

    const adapters = new Map<AgentId, AgentAdapter>([
      [
        'claude',
        new FakeAgentAdapter('claude', (input) => {
          if (input.permissions === 'workspace-write') {
            fs.writeFileSync(path.join(input.cwd, 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
          }
          return { chunks: ['Done'] };
        }),
      ],
      [
        'codex',
        new FakeAgentAdapter('codex', () => ({
          failWith: { errorCode: 'timeout', message: 'Reviewer timed out' },
        })),
      ],
    ]);

    const taskSvc = new TaskService(room, dataDir, db, adapters, new SecretRedactor({}));
    try {
      const started = await taskSvc.startTask('Fix add()');
      const res = await taskSvc.approve(started.approval.id);
      expect(res.task.state).toBe('FAILED');
      expect(res.finalApproval).toBeUndefined();
      const handle = taskSvc.getWorktreeHandle(started.task.id);
      if (handle) cleanupTaskWorktree(dataDir, repo, handle);
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
