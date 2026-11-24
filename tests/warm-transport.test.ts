import { describe, expect, it } from 'vitest';
import { WarmTransportPool } from '../src/adapters/warm-transport.js';

describe('WarmTransportPool', () => {
  it('registers and retrieves warm sessions by roomId and agentId', () => {
    const pool = new WarmTransportPool();
    const session = pool.register('room-1', 'claude', 'sess-claude-123');

    expect(session.roomId).toBe('room-1');
    expect(session.agentId).toBe('claude');
    expect(session.sessionId).toBe('sess-claude-123');
    expect(session.turnCount).toBe(1);

    const retrieved = pool.get('room-1', 'claude');
    expect(retrieved).toEqual(session);
  });

  it('increments turn count and updates lastUsedAt on subsequent registrations', async () => {
    const pool = new WarmTransportPool();
    pool.register('room-1', 'codex', 'sess-codex-1');
    const first = pool.get('room-1', 'codex')!;

    await new Promise((r) => setTimeout(r, 5));
    pool.register('room-1', 'codex', 'sess-codex-2');
    const second = pool.get('room-1', 'codex')!;

    expect(second.turnCount).toBe(2);
    expect(second.sessionId).toBe('sess-codex-2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastUsedAt).toBeGreaterThanOrEqual(first.lastUsedAt);
  });

  it('lists active sessions and clears by room or globally', () => {
    const pool = new WarmTransportPool();
    pool.register('room-A', 'claude', 'sess-A-1');
    pool.register('room-A', 'codex', 'sess-A-2');
    pool.register('room-B', 'agy', 'sess-B-1');

    expect(pool.list()).toHaveLength(3);
    expect(pool.list('room-A')).toHaveLength(2);
    expect(pool.list('room-B')).toHaveLength(1);

    pool.clear('room-A');
    expect(pool.list('room-A')).toHaveLength(0);
    expect(pool.list('room-B')).toHaveLength(1);

    pool.clear();
    expect(pool.list()).toHaveLength(0);
  });
});
