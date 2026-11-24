import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomService } from '../src/orchestrator/room-service.js';
import { ChayxonaDB } from '../src/persistence/db.js';
import { SecretRedactor } from '../src/security/redactor.js';
import { parseUserInput } from '../src/tui/commands.js';
import type { FindingRecord, MessageRecord, RoomRecord } from '../src/domain/types.js';

function makeRoom(repoPath: string): RoomRecord {
  return {
    id: 'r-export123',
    repoPath,
    baseSha: 'deadbeef',
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

describe('Room Export (md, jsonl, pr, html)', () => {
  it('parses /export variations with smart format and path detection', () => {
    expect(parseUserInput('/export')).toEqual({ kind: 'export', format: 'md', targetPath: undefined });
    expect(parseUserInput('/export jsonl')).toEqual({ kind: 'export', format: 'jsonl', targetPath: undefined });
    expect(parseUserInput('/export html')).toEqual({ kind: 'export', format: 'html', targetPath: undefined });
    expect(parseUserInput('/export pr')).toEqual({ kind: 'export', format: 'pr', targetPath: undefined });
    expect(parseUserInput('/export html ./out.html')).toEqual({ kind: 'export', format: 'html', targetPath: './out.html' });
    expect(parseUserInput('/export ./my-report.html')).toEqual({ kind: 'export', format: 'html', targetPath: './my-report.html' });
    expect(parseUserInput('/export ./data.jsonl')).toEqual({ kind: 'export', format: 'jsonl', targetPath: './data.jsonl' });
    expect(parseUserInput('/export ./notes.md')).toEqual({ kind: 'export', format: 'md', targetPath: './notes.md' });
  });

  it('exports room to HTML with dark mode styling, findings table, badges, and redacts secrets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-export-test-'));
    const db = new ChayxonaDB(':memory:');
    const room = makeRoom(tmp);
    db.createRoom(room);
    db.createRound(room.id, 'debate', 'SQL injection in auth flow', 'cross_exam_r2');

    const redactor = new SecretRedactor();
    const service = new RoomService(room, db, new Map(), redactor);

    // Insert messages
    const msg1: Omit<MessageRecord, 'seq'> = {
      id: 'm1',
      roomId: room.id,
      turnId: null,
      roundId: 1,
      roundPhase: 'blind_r1',
      sender: 'claude',
      recipients: ['all'],
      body: 'Found sensitive sk-ant-api03-abcdef1234567890abcdef1234567890 in user auth handler.',
      sealed: false,
      createdAt: Date.now() - 2000,
    };
    db.appendMessage(msg1);

    const msg2: Omit<MessageRecord, 'seq'> = {
      id: 'm2',
      roomId: room.id,
      turnId: null,
      roundId: 1,
      roundPhase: 'cross_exam_r2',
      sender: 'codex',
      recipients: ['all'],
      body: 'I disagree with Claude regarding query sanitization; parameterized statements suffice.',
      sealed: false,
      createdAt: Date.now() - 1000,
    };
    db.appendMessage(msg2);

    // Insert findings
    const finding1: FindingRecord = {
      id: 'f1',
      roomId: room.id,
      messageId: 'm1',
      roundId: 1,
      phase: 'r1',
      agentId: 'claude',
      canonicalId: 'R1-r1-claude-F1',
      severity: 'critical',
      file: 'src/auth.ts',
      line: 42,
      summary: 'Hardcoded API secret token in auth middleware',
      evidence: 'const key = "sk-ant-api03-abcdef1234567890abcdef1234567890";',
      agreesWith: [],
      dissentsFrom: [],
      createdAt: Date.now() - 2000,
    };

    const finding2: FindingRecord = {
      id: 'f2',
      roomId: room.id,
      messageId: 'm2',
      roundId: 1,
      phase: 'r2',
      agentId: 'codex',
      canonicalId: 'R1-r2-codex-F1',
      severity: 'medium',
      file: 'src/db.ts',
      line: 88,
      summary: 'Query escaping is missing in legacy fallback branch',
      evidence: 'db.query(`SELECT * FROM users WHERE id = ${id}`)',
      agreesWith: [],
      dissentsFrom: ['R1-r1-claude-F1'],
      createdAt: Date.now() - 1000,
    };
    db.insertFindings([finding1, finding2]);

    // 1. HTML export test
    const html = service.exportRoom('html');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Chayxona Debate — r-export123</title>');
    expect(html).toContain('badge badge-critical');
    expect(html).toContain('<code>R1-r1-claude-F1</code>');
    expect(html).toContain('src/auth.ts:42');
    expect(html).toContain('tag tag-dissent');
    expect(html).toContain('R1-r1-claude-F1');
    expect(html).toContain('message claude');
    expect(html).toContain('message codex');
    // Secret was redacted
    expect(html).not.toContain('sk-ant-api03-abcdef1234567890abcdef1234567890');
    expect(html).toContain('[REDACTED]');

    // 2. MD export test
    const md = service.exportRoom('md');
    expect(md).toContain('# Chayxona Debate Transcript — r-export123');
    expect(md).toContain('## Transcript');
    expect(md).toContain('### CLAUDE *(round 1 · blind_r1)*');
    expect(md).toContain('## Room Summary (r-export123)');
    expect(md).not.toContain('sk-ant-api03-abcdef1234567890abcdef1234567890');

    // 3. JSONL export test
    const jsonl = service.exportRoom('jsonl');
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].type).toBe('room');
    expect(parsed[1].type).toBe('message');
    expect(jsonl).not.toContain('sk-ant-api03-abcdef1234567890abcdef1234567890');

    // 4. PR decision card test
    const pr = service.exportRoom('pr');
    expect(pr).toContain('## Chayxona Cross-Model Review');
    expect(pr).toContain('| Severity | ID | Location | Summary | Dissent |');
    expect(pr).toContain('`R1-r2-codex-F1`');
    expect(pr).toContain('<details>');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
