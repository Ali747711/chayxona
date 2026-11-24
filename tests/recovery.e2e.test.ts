import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/contract.js';
import { FakeAgentAdapter } from '../src/adapters/fake.js';
import type { AgentId, RoomRecord } from '../src/domain/types.js';
import { RoomService } from '../src/orchestrator/room-service.js';
import { ChayxonaDB } from '../src/persistence/db.js';
import { SecretRedactor } from '../src/security/redactor.js';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-rec-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@chayxona.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const ok = true;\n');
  execFileSync('git', ['add', 'index.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function seedMidBlindCrash(db: ChayxonaDB, repo: string): RoomRecord {
  const room: RoomRecord = {
    id: 'r-crash',
    repoPath: repo,
    baseSha: 'head',
    status: 'active',
    maxTurns: 24,
    agents: ['claude', 'codex', 'agy'],
    solo: false,
    turnTimeoutMs: 5000,
    maxConcurrency: 3,
    createdAt: 1,
    updatedAt: 1,
  };
  db.createRoom(room);
  const round = db.createRound(room.id, 'debate', 'Crash recovery topic', 'blind_r1');

  // 2 done sealed takes + 1 running (crashed) turn + 1 persisted steering note
  db.createTurn({
    id: 't-claude',
    roomId: room.id,
    roundId: round.id,
    roundPhase: 'blind_r1',
    agentId: 'claude',
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    errorCode: null,
  });
  db.appendMessage({
    id: 'm-claude',
    roomId: room.id,
    turnId: 't-claude',
    roundId: round.id,
    roundPhase: 'blind_r1',
    sender: 'claude',
    recipients: ['human'],
    body: 'Claude sealed R1 take',
    sealed: true,
    createdAt: 2,
  });

  db.createTurn({
    id: 't-codex',
    roomId: room.id,
    roundId: round.id,
    roundPhase: 'blind_r1',
    agentId: 'codex',
    status: 'done',
    startedAt: 1,
    endedAt: 3,
    errorCode: null,
  });
  db.appendMessage({
    id: 'm-codex',
    roomId: room.id,
    turnId: 't-codex',
    roundId: round.id,
    roundPhase: 'blind_r1',
    sender: 'codex',
    recipients: ['human'],
    body: 'Codex sealed R1 take',
    sealed: true,
    createdAt: 3,
  });

  db.createTurn({
    id: 't-agy',
    roomId: room.id,
    roundId: round.id,
    roundPhase: 'blind_r1',
    agentId: 'agy',
    status: 'running',
    startedAt: 1,
    endedAt: null,
    errorCode: null,
  });

  db.appendMessage({
    id: 'm-steer',
    roomId: room.id,
    turnId: null,
    roundId: round.id,
    roundPhase: 'steering',
    sender: 'human',
    recipients: room.agents,
    body: 'Focus on memory safety',
    sealed: false,
    createdAt: 4,
  });

  return room;
}

describe('Crash recovery on resume', () => {
  it('unseals completed Blind R1 takes and runs R2 via recoverUnsealAndContinue', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = seedMidBlindCrash(db, repo);
    expect(db.markRunningTurnsInterrupted(room.id)).toBe(1);

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ chunks: ['Claude R2'] }))],
      ['codex', new FakeAgentAdapter('codex', () => ({ chunks: ['Codex R2'] }))],
      ['agy', new FakeAgentAdapter('agy', () => ({ chunks: ['Should not run'] }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const state = service.inspectRecoveryState();
    expect(state?.kind).toBe('incomplete_blind_r1');
    if (state?.kind === 'incomplete_blind_r1') {
      expect(state.completedAgents.sort()).toEqual(['claude', 'codex']);
      expect(state.interruptedAgents).toEqual(['agy']);
    }

    const res = await service.recoverUnsealAndContinue();
    expect(res.status).toBe('degraded');
    expect(res.exitCode).toBe(2);
    expect(db.listMessages(room.id).map((m) => m.sender)).toContain('claude');
    expect(db.listMessages(room.id).map((m) => m.sender)).toContain('codex');
    expect(service.inspectRecoveryState()).toBeNull();

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('retries only interrupted Blind R1 agent via recoverRetryInterrupted and completes R2 with all 3', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = seedMidBlindCrash(db, repo);
    db.markRunningTurnsInterrupted(room.id);

    const calls: string[] = [];
    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => { calls.push('claude'); return { chunks: ['Claude R2'] }; })],
      ['codex', new FakeAgentAdapter('codex', () => { calls.push('codex'); return { chunks: ['Codex R2'] }; })],
      ['agy', new FakeAgentAdapter('agy', () => { calls.push('agy'); return { chunks: ['Agy recovered'] }; })],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const res = await service.recoverRetryInterrupted();
    expect(res.status).toBe('completed');
    expect(res.exitCode).toBe(0);
    // Agy ran R1 retry + R2 (2 calls); claude & codex ran R2 only (1 call each)
    expect(calls.filter((c) => c === 'agy')).toHaveLength(2);
    expect(calls.filter((c) => c === 'claude')).toHaveLength(1);
    expect(calls.filter((c) => c === 'codex')).toHaveLength(1);

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('resumes revealed_pending_r2 via recoverResumePendingR2', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = seedMidBlindCrash(db, repo);
    db.markRunningTurnsInterrupted(room.id);
    db.unsealRoundMessages(room.id, 1);
    db.updateRound(room.id, 1, { phase: 'revealed_pending_r2' });

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ chunks: ['Claude R2'] }))],
      ['codex', new FakeAgentAdapter('codex', () => ({ chunks: ['Codex R2'] }))],
      ['agy', new FakeAgentAdapter('agy', () => ({ chunks: ['Agy unused'] }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    expect(service.inspectRecoveryState()?.kind).toBe('pending_r2');
    const res = await service.recoverResumePendingR2();
    expect(res.status).toBe('completed');
    expect(service.inspectRecoveryState()).toBeNull();

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
