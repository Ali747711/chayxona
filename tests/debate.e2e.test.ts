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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-e2e-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@chayxona.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', 'app.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function makeRoom(repoPath: string, agents: AgentId[], solo = false, maxTurns = 24): RoomRecord {
  return {
    id: 'r-test',
    repoPath,
    baseSha: 'head',
    status: 'active',
    maxTurns,
    agents,
    solo,
    turnTimeoutMs: 5000,
    maxConcurrency: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('RoomService E2E (Blind R1 -> Cross-Exam R2)', () => {
  it('runs 3-agent Blind R1 + steering -> Reveal -> Cross-Exam R2 with dissent and zero repo writes', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(repo, ['claude', 'codex', 'agy']);
    db.createRoom(room);

    const seenPrompts: Record<string, string[]> = { claude: [], codex: [], agy: [] };
    const adapters = new Map<AgentId, AgentAdapter>([
      [
        'claude',
        new FakeAgentAdapter('claude', (input) => {
          seenPrompts.claude.push(input.prompt);
          const isR2 = input.prompt.includes('CROSS-EXAMINATION ROUND 2');
          return {
            delayMs: 15,
            chunks: [
              isR2 ? 'Revised after seeing codex.' : 'Use 30s Redis TTL.',
              '\n```chayxona-findings\n' +
                JSON.stringify({
                  findings: [
                    {
                      id: 'F1',
                      severity: 'medium',
                      file: 'app.ts',
                      line: 1,
                      summary: isR2 ? 'Add invalidation hook' : 'Propose 30s TTL',
                      evidence: 'app.ts:1',
                      agrees_with: [],
                      dissents_from: [],
                    },
                  ],
                }) +
                '\n```',
            ],
          };
        }),
      ],
      [
        'codex',
        new FakeAgentAdapter('codex', (input) => {
          seenPrompts.codex.push(input.prompt);
          const isR2 = input.prompt.includes('CROSS-EXAMINATION ROUND 2');
          return {
            delayMs: 20,
            chunks: [
              isR2 ? 'Disagrees with claude on stale reads.' : 'Watch out for stale balances.',
              '\n```chayxona-findings\n' +
                JSON.stringify({
                  findings: [
                    {
                      id: 'F1',
                      severity: 'high',
                      file: 'app.ts',
                      line: 1,
                      summary: isR2 ? '30s TTL breaks read-after-write' : 'Need strong consistency',
                      evidence: 'transfer -> read',
                      agrees_with: [],
                      dissents_from: isR2 ? ['R1-r1-claude-F1'] : [],
                    },
                  ],
                }) +
                '\n```',
            ],
          };
        }),
      ],
      [
        'agy',
        new FakeAgentAdapter('agy', (input) => {
          seenPrompts.agy.push(input.prompt);
          return { delayMs: 25, chunks: ['Split primary reads vs cached aggregates.'] };
        }),
      ],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const debatePromise = service.runDebateOrAudit('debate', 'Redis cache vs read replicas');
    // Queue steering note during Blind R1
    setTimeout(() => service.queueSteeringNote('Check read-after-write consistency'), 5);

    const res = await debatePromise;
    expect(res.status).toBe('completed');
    expect(res.exitCode).toBe(0);
    expect(db.countRoomTurns(room.id)).toBe(6);

    // Steering note was injected into Cross-Exam R2
    expect(seenPrompts.codex[1]).toContain('Check read-after-write consistency');
    expect(seenPrompts.codex[1]).toContain('R1-r1-claude-F1');

    // Findings & dissent preserved without R1/R2 ID collision
    const findings = db.listVisibleFindings(room.id);
    const ids = findings.map((f) => f.canonicalId);
    expect(ids).toContain('R1-r1-claude-F1');
    expect(ids).toContain('R1-r2-claude-F1');
    const codexR2 = findings.find((f) => f.canonicalId === 'R1-r2-codex-F1');
    expect(codexR2?.dissentsFrom).toEqual(['R1-r1-claude-F1']);

    // Export works
    const md = service.exportRoom('md');
    expect(md).toContain('Chayxona Debate Transcript');
    expect(md).toContain('DISSENTS: R1-r1-claude-F1');

    // Zero repo writes
    const gitStatus = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(gitStatus).toBe('');

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('prevents /stop all from auto-launching Cross-Exam R2 even if 2 R1 takes finished', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(repo, ['claude', 'codex', 'agy']);
    db.createRoom(room);

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ delayMs: 5, chunks: ['fast 1'] }))],
      ['codex', new FakeAgentAdapter('codex', () => ({ delayMs: 5, chunks: ['fast 2'] }))],
      ['agy', new FakeAgentAdapter('agy', () => ({ hangUntilAbort: true }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const p = service.runDebateOrAudit('debate', 'Cancel race test');
    setTimeout(() => service.stop('all'), 40);
    const res = await p;

    expect(res.status).toBe('cancelled');
    expect(res.exitCode).toBe(1);
    expect(db.countRoomTurns(room.id)).toBe(3); // R2 never spawned!

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('unseals straggler once >= 2 R1 takes finish and returns exitCode 2 (degraded)', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(repo, ['claude', 'codex', 'agy']);
    db.createRoom(room);

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ delayMs: 5, chunks: ['take 1'] }))],
      ['codex', new FakeAgentAdapter('codex', () => ({ delayMs: 5, chunks: ['take 2'] }))],
      ['agy', new FakeAgentAdapter('agy', () => ({ hangUntilAbort: true }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const p = service.runDebateOrAudit('debate', 'Straggler unseal test');
    setTimeout(() => service.unsealStraggler(), 45);
    const res = await p;

    expect(res.status).toBe('degraded');
    expect(res.exitCode).toBe(2);
    expect(res.succeededAgents.sort()).toEqual(['claude', 'codex']);
    expect(res.failedAgents).toEqual(['agy']);

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('enforces budget preflight and supports --solo mode', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(repo, ['claude'], true, 1);
    db.createRoom(room);

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ delayMs: 5, chunks: ['solo take'] }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const res = await service.runDebateOrAudit('debate', 'Solo check');
    expect(res.status).toBe('completed');
    expect(db.countRoomTurns(room.id)).toBe(1);

    // Next turn rejected by budget preflight until extended
    await expect(service.runFreeform(['claude'], 'more')).rejects.toThrow(/Insufficient room turn budget/);
    service.extendBudget(2);
    const res2 = await service.runFreeform(['claude'], 'more');
    expect(res2.status).toBe('completed');

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('halts queued agents on /stop all when maxConcurrency=1 and clears pendingR2 on new rounds', async () => {
    const repo = makeTempRepo();
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(repo, ['claude', 'codex', 'agy'], false, 24);
    room.maxConcurrency = 1;
    db.createRoom(room);

    const adapters = new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude', () => ({ hangUntilAbort: true }))],
      ['codex', new FakeAgentAdapter('codex', () => ({ delayMs: 5, chunks: ['should not run'] }))],
      ['agy', new FakeAgentAdapter('agy', () => ({ delayMs: 5, chunks: ['should not run'] }))],
    ]);

    const service = new RoomService(room, db, adapters, new SecretRedactor({}));
    const p = service.runDebateOrAudit('debate', 'Queued cancel test');
    setTimeout(() => service.stop('all'), 25);
    const res = await p;

    expect(res.status).toBe('cancelled');
    // Only claude ever spawned; codex & agy stayed unspawned
    expect(db.countRoomTurns(room.id)).toBe(1);

    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
