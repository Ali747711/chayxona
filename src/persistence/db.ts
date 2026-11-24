import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentId,
  FindingRecord,
  MessagePhase,
  MessageRecord,
  RoomRecord,
  RoundKind,
  RoundPhase,
  RoundRecord,
  TurnRecord,
  TurnStatus,
  AdapterErrorCode,
} from '../domain/types.js';

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHAYXONA_DATA_DIR && env.CHAYXONA_DATA_DIR.trim()) {
    return path.resolve(env.CHAYXONA_DATA_DIR.trim());
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'chayxona');
  }
  const xdg = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'chayxona');
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const resolvedParent = fs.existsSync(parentPath) ? fs.realpathSync(parentPath) : path.resolve(parentPath);
  const resolvedChild = fs.existsSync(childPath) ? fs.realpathSync(childPath) : path.resolve(childPath);
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  max_turns INTEGER NOT NULL DEFAULT 24,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL,
  phase TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  paused_after_r1 INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL,
  round_phase TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  round_id INTEGER NOT NULL,
  round_phase TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  body TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL,
  agrees_with_json TEXT NOT NULL,
  dissents_from_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, canonical_id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  turn_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (room_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_turns_room ON turns(room_id, round_id);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_findings_room ON findings(room_id, round_id);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, seq);
`;

export class ChayxonaDB {
  readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version < 1) {
      this.withImmediateTx(() => {
        this.db.exec(SCHEMA_V1_SQL);
        this.db.exec('PRAGMA user_version = 1;');
      });
    }
  }

  /**
   * Always uses BEGIN IMMEDIATE to avoid SQLite WAL deferred-transaction
   * read-to-write promotion deadlocks (SQLITE_BUSY).
   */
  withImmediateTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure if already rolled back
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Rooms ---

  createRoom(room: RoomRecord): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO rooms (id, repo_path, base_sha, status, max_turns, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room.id,
          room.repoPath,
          room.baseSha,
          room.status,
          room.maxTurns,
          JSON.stringify({
            agents: room.agents,
            solo: room.solo,
            turnTimeoutMs: room.turnTimeoutMs,
            maxConcurrency: room.maxConcurrency,
          }),
          room.createdAt,
          room.updatedAt,
        );
    });
  }

  getRoom(roomId: string): RoomRecord | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRoom(row);
  }

  listRooms(limit = 30): RoomRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rooms ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRoom(r));
  }

  extendRoomBudget(roomId: string, delta: number, now = Date.now()): number {
    return this.withImmediateTx(() => {
      this.db
        .prepare('UPDATE rooms SET max_turns = max_turns + ?, updated_at = ? WHERE id = ?')
        .run(delta, now, roomId);
      const row = this.db.prepare('SELECT max_turns FROM rooms WHERE id = ?').get(roomId) as { max_turns: number };
      return row.max_turns;
    });
  }

  private mapRoom(row: Record<string, unknown>): RoomRecord {
    const cfg = JSON.parse(String(row.config_json)) as {
      agents: AgentId[];
      solo: boolean;
      turnTimeoutMs: number;
      maxConcurrency: number;
    };
    return {
      id: String(row.id),
      repoPath: String(row.repo_path),
      baseSha: row.base_sha ? String(row.base_sha) : null,
      status: String(row.status) as 'active' | 'closed',
      maxTurns: Number(row.max_turns),
      agents: cfg.agents,
      solo: Boolean(cfg.solo),
      turnTimeoutMs: Number(cfg.turnTimeoutMs),
      maxConcurrency: Number(cfg.maxConcurrency),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // --- Rounds ---

  createRound(roomId: string, kind: RoundKind, topic: string, phase: RoundPhase, now = Date.now()): RoundRecord {
    return this.withImmediateTx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM rounds WHERE room_id = ?')
        .get(roomId) as { max_id: number };
      const id = row.max_id + 1;
      this.db
        .prepare(
          `INSERT INTO rounds (id, room_id, kind, topic, phase, cancelled, paused_after_r1, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        )
        .run(id, roomId, kind, topic, phase, now, now);
      this.db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, roomId);
      return {
        id,
        roomId,
        kind,
        topic,
        phase,
        cancelled: false,
        pausedAfterR1: false,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  updateRound(
    roomId: string,
    roundId: number,
    patch: Partial<{ phase: RoundPhase; cancelled: boolean; pausedAfterR1: boolean }>,
    now = Date.now(),
  ): void {
    this.withImmediateTx(() => {
      const current = this.getRound(roomId, roundId);
      if (!current) return;
      this.db
        .prepare(
          `UPDATE rounds SET phase = ?, cancelled = ?, paused_after_r1 = ?, updated_at = ?
           WHERE room_id = ? AND id = ?`,
        )
        .run(
          patch.phase ?? current.phase,
          (patch.cancelled ?? current.cancelled) ? 1 : 0,
          (patch.pausedAfterR1 ?? current.pausedAfterR1) ? 1 : 0,
          now,
          roomId,
          roundId,
        );
      this.db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, roomId);
    });
  }

  getRound(roomId: string, roundId: number): RoundRecord | null {
    const row = this.db
      .prepare('SELECT * FROM rounds WHERE room_id = ? AND id = ?')
      .get(roomId, roundId) as Record<string, unknown> | undefined;
    return row ? this.mapRound(row) : null;
  }

  getLatestRound(roomId: string): RoundRecord | null {
    const row = this.db
      .prepare('SELECT * FROM rounds WHERE room_id = ? ORDER BY id DESC LIMIT 1')
      .get(roomId) as Record<string, unknown> | undefined;
    return row ? this.mapRound(row) : null;
  }

  private mapRound(row: Record<string, unknown>): RoundRecord {
    return {
      id: Number(row.id),
      roomId: String(row.room_id),
      kind: String(row.kind) as RoundKind,
      topic: String(row.topic),
      phase: String(row.phase) as RoundPhase,
      cancelled: Number(row.cancelled) === 1,
      pausedAfterR1: Number(row.paused_after_r1) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // --- Turns ---

  createTurn(turn: TurnRecord): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO turns (id, room_id, round_id, round_phase, agent_id, status, started_at, ended_at, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.id,
          turn.roomId,
          turn.roundId,
          turn.roundPhase,
          turn.agentId,
          turn.status,
          turn.startedAt,
          turn.endedAt,
          turn.errorCode,
        );
    });
  }

  finishTurn(turnId: string, status: TurnStatus, errorCode: AdapterErrorCode | null = null, now = Date.now()): void {
    this.withImmediateTx(() => {
      this.db
        .prepare('UPDATE turns SET status = ?, ended_at = ?, error_code = ? WHERE id = ?')
        .run(status, now, errorCode, turnId);
    });
  }

  countRoomTurns(roomId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM turns WHERE room_id = ?')
      .get(roomId) as { cnt: number };
    return row.cnt;
  }

  listRoundTurns(roomId: string, roundId: number, roundPhase?: MessagePhase): TurnRecord[] {
    const sql = roundPhase
      ? 'SELECT * FROM turns WHERE room_id = ? AND round_id = ? AND round_phase = ? ORDER BY started_at ASC'
      : 'SELECT * FROM turns WHERE room_id = ? AND round_id = ? ORDER BY started_at ASC';
    const rows = (roundPhase
      ? this.db.prepare(sql).all(roomId, roundId, roundPhase)
      : this.db.prepare(sql).all(roomId, roundId)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      roomId: String(r.room_id),
      roundId: Number(r.round_id),
      roundPhase: String(r.round_phase) as MessagePhase,
      agentId: String(r.agent_id) as AgentId,
      status: String(r.status) as TurnStatus,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : null,
      errorCode: r.error_code ? (String(r.error_code) as AdapterErrorCode) : null,
    }));
  }

  markRunningTurnsInterrupted(roomId: string, now = Date.now()): number {
    return this.withImmediateTx(() => {
      const res = this.db
        .prepare("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE room_id = ? AND status = 'running'")
        .run(now, roomId);
      return Number(res.changes);
    });
  }

  // --- Messages ---

  appendMessage(msg: Omit<MessageRecord, 'seq'>): MessageRecord {
    return this.withImmediateTx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE room_id = ?')
        .get(msg.roomId) as { max_seq: number };
      const seq = row.max_seq + 1;
      this.db
        .prepare(
          `INSERT INTO messages (id, room_id, turn_id, round_id, round_phase, sender, recipients_json, body, sealed, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          msg.id,
          msg.roomId,
          msg.turnId,
          msg.roundId,
          msg.roundPhase,
          msg.sender,
          JSON.stringify(msg.recipients),
          msg.body,
          msg.sealed ? 1 : 0,
          seq,
          msg.createdAt,
        );
      return { ...msg, seq };
    });
  }

  unsealRoundMessages(roomId: string, roundId: number): MessageRecord[] {
    return this.withImmediateTx(() => {
      this.db
        .prepare('UPDATE messages SET sealed = 0 WHERE room_id = ? AND round_id = ? AND sealed = 1')
        .run(roomId, roundId);
      return this.listMessages(roomId, { roundId, includeSealed: false });
    });
  }

  listMessages(
    roomId: string,
    opts: { roundId?: number; roundPhase?: MessagePhase; includeSealed?: boolean; limit?: number } = {},
  ): MessageRecord[] {
    const clauses = ['room_id = ?'];
    const params: (string | number)[] = [roomId];
    if (opts.roundId !== undefined) {
      clauses.push('round_id = ?');
      params.push(opts.roundId);
    }
    if (opts.roundPhase !== undefined) {
      clauses.push('round_phase = ?');
      params.push(opts.roundPhase);
    }
    if (!opts.includeSealed) {
      clauses.push('sealed = 0');
    }
    let sql = `SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`;
    if (opts.limit !== undefined) {
      sql = `SELECT * FROM (${sql} DESC LIMIT ?) ORDER BY seq ASC`;
      // Rewrite cleanly to take last N messages
      sql = `SELECT * FROM (SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`;
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      roomId: String(r.room_id),
      turnId: r.turn_id ? String(r.turn_id) : null,
      roundId: Number(r.round_id),
      roundPhase: String(r.round_phase) as MessagePhase,
      sender: String(r.sender) as MessageRecord['sender'],
      recipients: JSON.parse(String(r.recipients_json)) as string[],
      body: String(r.body),
      sealed: Number(r.sealed) === 1,
      seq: Number(r.seq),
      createdAt: Number(r.created_at),
    }));
  }

  // --- Findings ---

  insertFindings(items: readonly FindingRecord[]): void {
    if (items.length === 0) return;
    this.withImmediateTx(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO findings
         (id, room_id, message_id, round_id, phase, agent_id, canonical_id, severity, file, line, summary, evidence, agrees_with_json, dissents_from_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of items) {
        stmt.run(
          f.id,
          f.roomId,
          f.messageId,
          f.roundId,
          f.phase,
          f.agentId,
          f.canonicalId,
          f.severity,
          f.file,
          f.line,
          f.summary,
          f.evidence,
          JSON.stringify(f.agreesWith),
          JSON.stringify(f.dissentsFrom),
          f.createdAt,
        );
      }
    });
  }

  /**
   * Enforces the blind visibility gate: findings whose parent message is still
   * `sealed = 1` are excluded by default so UI, counts, summaries, and exports
   * cannot leak unrevealed Blind R1 answers.
   */
  listVisibleFindings(roomId: string, opts: { roundId?: number } = {}): FindingRecord[] {
    const clauses = ['f.room_id = ?', 'm.sealed = 0'];
    const params: (string | number)[] = [roomId];
    if (opts.roundId !== undefined) {
      clauses.push('f.round_id = ?');
      params.push(opts.roundId);
    }
    const sql = `
      SELECT f.* FROM findings f
      JOIN messages m ON m.id = f.message_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.created_at ASC
    `;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      roomId: String(r.room_id),
      messageId: String(r.message_id),
      roundId: Number(r.round_id),
      phase: String(r.phase) as 'r1' | 'r2' | 'freeform',
      agentId: String(r.agent_id) as AgentId,
      canonicalId: String(r.canonical_id),
      severity: String(r.severity) as FindingRecord['severity'],
      file: r.file ? String(r.file) : null,
      line: r.line !== null && r.line !== undefined ? Number(r.line) : null,
      summary: String(r.summary),
      evidence: String(r.evidence),
      agreesWith: JSON.parse(String(r.agrees_with_json)) as string[],
      dissentsFrom: JSON.parse(String(r.dissents_from_json)) as string[],
      createdAt: Number(r.created_at),
    }));
  }

  // --- Events & Provider Sessions ---

  appendEvent(roomId: string, turnId: string | null, agentId: AgentId | null, type: string, payload: unknown, now = Date.now()): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO events (room_id, turn_id, agent_id, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, turnId, agentId, type, JSON.stringify(payload), now);
    });
  }

  listVisibleEvents(roomId: string): Array<{ seq: number; turnId: string | null; agentId: string | null; type: string; payload: unknown; createdAt: number }> {
    // Exclude events belonging to turns whose round is still in blind_r1
    const sql = `
      SELECT e.* FROM events e
      LEFT JOIN turns t ON t.id = e.turn_id
      LEFT JOIN rounds r ON r.room_id = e.room_id AND r.id = t.round_id
      WHERE e.room_id = ? AND (r.phase IS NULL OR r.phase != 'blind_r1')
      ORDER BY e.seq ASC
    `;
    const rows = this.db.prepare(sql).all(roomId) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      turnId: r.turn_id ? String(r.turn_id) : null,
      agentId: r.agent_id ? String(r.agent_id) : null,
      type: String(r.type),
      payload: JSON.parse(String(r.payload_json)),
      createdAt: Number(r.created_at),
    }));
  }

  upsertProviderSession(roomId: string, agentId: AgentId, externalSessionId: string, now = Date.now()): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO provider_sessions (id, room_id, agent_id, provider, external_session_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'bound', ?)
           ON CONFLICT(room_id, agent_id) DO UPDATE SET external_session_id = excluded.external_session_id, updated_at = excluded.updated_at`,
        )
        .run(`${roomId}:${agentId}`, roomId, agentId, agentId, externalSessionId, now);
    });
  }
}
