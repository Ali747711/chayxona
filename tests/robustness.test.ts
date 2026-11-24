import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeAgentAdapter } from '../src/adapters/fake.js';
import { RoomService } from '../src/orchestrator/room-service.js';
import { TaskService } from '../src/orchestrator/task-service.js';
import { ChayxonaDB } from '../src/persistence/db.js';
import { SecretRedactor } from '../src/security/redactor.js';
import type { AgentEvent, RoomRecord, TaskRecord } from '../src/domain/types.js';

function makeRoom(repoPath: string, baseSha = 'deadbeef'): RoomRecord {
  return {
    id: 'r-robust-test',
    repoPath,
    baseSha,
    status: 'active',
    maxTurns: 24,
    agents: ['claude', 'codex', 'agy'],
    solo: false,
    turnTimeoutMs: 60000,
    maxConcurrency: 2,
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
  };
}

function makeTask(id: string, roomId: string): TaskRecord {
  return {
    id,
    roomId,
    description: 'Dummy test task',
    state: 'IMPLEMENTING',
    implementer: 'claude',
    reviewers: ['codex'],
    baseSha: 'deadbeef',
    planVersion: 1,
    planText: 'plan',
    planHash: 'hash1',
    activeRevisionId: null,
    revisionCount: 0,
    maxRevisions: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Robustness & Resilience Enhancements', () => {
  it('TaskService supports isRunning(), stop(), and forwards agent events and task updates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-robust-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@chayxona.local'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'index.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(tmp, baseSha);
    db.createRoom(room);

    const receivedEvents: AgentEvent[] = [];
    const receivedStatuses: string[] = [];
    const updatedTasks: TaskRecord[] = [];

    const adapters = new Map([
      ['claude' as const, new FakeAgentAdapter('claude')],
      ['codex' as const, new FakeAgentAdapter('codex')],
      ['agy' as const, new FakeAgentAdapter('agy')],
    ]);

    const taskService = new TaskService(
      room,
      tmp,
      db,
      adapters,
      new SecretRedactor(),
      [],
      {
        onStatus: (t) => receivedStatuses.push(t),
        onAgentEvent: (e) => receivedEvents.push(e),
        onTaskUpdated: (task) => updatedTasks.push(task),
      },
    );

    expect(taskService.isRunning()).toBe(false);

    // Start task plan
    const { task, approval } = await taskService.startTask('Refactor auth token verification');
    expect(task.state).toBe('AWAITING_PLAN_APPROVAL');
    expect(approval.kind).toBe('plan');
    expect(updatedTasks.length).toBeGreaterThan(0);
    expect(receivedStatuses.length).toBeGreaterThan(0);

    // Stop works cleanly
    taskService.stop();
    expect(taskService.isRunning()).toBe(false);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reclaims stale writer lease if previous PID is dead', () => {
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom('/tmp/fake-repo');
    db.createRoom(room);
    db.createTask(makeTask('task-dead', room.id));
    db.createTask(makeTask('task-new', room.id));

    // Simulate an abandoned lease left by a non-existent dead PID
    const deadPid = 999999999;
    db.acquireWriterLease(room.id, 'task-dead', 'claude', '/tmp/worktree-1');
    // Manually overwrite pid with deadPid
    (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare('UPDATE writer_leases SET pid = ? WHERE room_id = ?')
      .run(deadPid, room.id);

    const before = db.getWriterLease(room.id);
    expect(before?.pid).toBe(deadPid);

    // Now re-acquiring the writer lease should detect deadPid, reclaim the lease, and succeed!
    db.acquireWriterLease(room.id, 'task-new', 'codex', '/tmp/worktree-2');
    const after = db.getWriterLease(room.id);
    expect(after?.taskId).toBe('task-new');
    expect(after?.holderAgent).toBe('codex');
    expect(after?.pid).toBe(process.pid);

    db.close();
  });

  it('detects incomplete_r2 recovery state when Round 2 was interrupted', () => {
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom('/tmp/fake-repo');
    db.createRoom(room);
    const round = db.createRound(room.id, 'debate', 'Architecture debate', 'blind_r1');

    // Simulate R1 completed
    for (const a of ['claude', 'codex', 'agy'] as const) {
      db.createTurn({
        id: `turn-${a}-r1`,
        roomId: room.id,
        roundId: round.id,
        roundPhase: 'blind_r1',
        agentId: a,
        status: 'done',
        startedAt: Date.now() - 5000,
        endedAt: Date.now() - 4000,
        errorCode: null,
      });
    }

    // Move round to cross_exam_r2
    db.updateRound(room.id, round.id, { phase: 'cross_exam_r2' });

    // Only claude completed R2; codex and agy were interrupted
    db.createTurn({
      id: 'turn-claude-r2',
      roomId: room.id,
      roundId: round.id,
      roundPhase: 'cross_exam_r2',
      agentId: 'claude',
      status: 'done',
      startedAt: Date.now() - 3000,
      endedAt: Date.now() - 2000,
      errorCode: null,
    });
    db.createTurn({
      id: 'turn-codex-r2',
      roomId: room.id,
      roundId: round.id,
      roundPhase: 'cross_exam_r2',
      agentId: 'codex',
      status: 'interrupted',
      startedAt: Date.now() - 3000,
      endedAt: Date.now() - 2000,
      errorCode: null,
    });

    const service = new RoomService(room, db, new Map(), new SecretRedactor());
    const recovery = service.inspectRecoveryState();

    expect(recovery).not.toBeNull();
    expect(recovery?.kind).toBe('incomplete_r2');
    if (recovery && recovery.kind === 'incomplete_r2') {
      expect(recovery.interruptedAgents).toContain('codex');
      expect(recovery.interruptedAgents).toContain('agy');
    }

    db.close();
  });
});
