import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChayxonaDB } from '../src/persistence/db.js';
import { RoomLock, RoomLockError } from '../src/persistence/room-lock.js';

describe('ChayxonaDB & RoomLock', () => {
  it('enforces blind visibility gate on messages, findings, and events', () => {
    const db = new ChayxonaDB(':memory:');
    db.createRoom({
      id: 'r-1',
      repoPath: '/tmp/repo',
      baseSha: 'abc123',
      status: 'active',
      maxTurns: 24,
      agents: ['claude', 'codex'],
      solo: false,
      turnTimeoutMs: 60_000,
      maxConcurrency: 3,
      createdAt: 1,
      updatedAt: 1,
    });
    const round = db.createRound('r-1', 'debate', 'test', 'blind_r1');
    db.createTurn({
      id: 't-1',
      roomId: 'r-1',
      roundId: round.id,
      roundPhase: 'blind_r1',
      agentId: 'claude',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      errorCode: null,
    });
    db.appendMessage({
      id: 'm-1',
      roomId: 'r-1',
      turnId: 't-1',
      roundId: round.id,
      roundPhase: 'blind_r1',
      sender: 'claude',
      recipients: ['human'],
      body: 'Secret R1 take',
      sealed: true,
      createdAt: 2,
    });
    db.insertFindings([
      {
        id: 'f-1',
        roomId: 'r-1',
        messageId: 'm-1',
        roundId: round.id,
        phase: 'r1',
        agentId: 'claude',
        canonicalId: 'R1-r1-claude-F1',
        severity: 'high',
        file: 'a.ts',
        line: 10,
        summary: 'Bug',
        evidence: 'ev',
        agreesWith: [],
        dissentsFrom: [],
        createdAt: 2,
      },
    ]);
    db.appendEvent('r-1', 't-1', 'claude', 'tool.started', { toolName: 'Read' });

    // Before unseal: zero leaks
    expect(db.listMessages('r-1')).toHaveLength(0);
    expect(db.listVisibleFindings('r-1')).toHaveLength(0);
    expect(db.listVisibleEvents('r-1')).toHaveLength(0);

    // Crash recovery marks running turns interrupted
    expect(db.markRunningTurnsInterrupted('r-1')).toBe(1);

    // After unseal + phase change: visible
    db.unsealRoundMessages('r-1', round.id);
    db.updateRound('r-1', round.id, { phase: 'done' });
    expect(db.listMessages('r-1')).toHaveLength(1);
    expect(db.listVisibleFindings('r-1')).toHaveLength(1);
    expect(db.listVisibleEvents('r-1')).toHaveLength(1);
    db.close();
  });

  it('prevents concurrent room ownership and cleans stale PID locks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-lock-'));
    try {
      const lock1 = RoomLock.acquire(dir, 'r-lock');
      expect(() => RoomLock.acquire(dir, 'r-lock')).toThrow(RoomLockError);
      lock1.release();

      // Simulate stale lock from dead PID
      const lockPath = path.join(dir, 'locks', 'r-stale.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: 1 }));
      const lock2 = RoomLock.acquire(dir, 'r-stale');
      lock2.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
