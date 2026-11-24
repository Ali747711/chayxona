import { describe, expect, it } from 'vitest';
import { getInputSuggestions, parseUserInput } from '../src/tui/commands.js';

describe('TUI command parser', () => {
  it('recognizes /agents and /agent locally', () => {
    expect(parseUserInput('/agents')).toEqual({ kind: 'agents' });
    expect(parseUserInput('/agent')).toEqual({ kind: 'agents' });
  });

  it('rejects unrecognized /slash commands instead of falling through to plain broadcast', () => {
    expect(parseUserInput('/foobar')).toEqual({ kind: 'unknown_slash', command: '/foobar' });
    expect(parseUserInput('/debte hello')).toEqual({ kind: 'unknown_slash', command: '/debte' });
  });

  it('parses @mentions, /debate, /audit, /task, and plain text cleanly', () => {
    expect(parseUserInput('@codex check this')).toEqual({ kind: 'mention', target: 'codex', body: 'check this' });
    expect(parseUserInput('/debate Redis vs Postgres')).toEqual({ kind: 'debate', topic: 'Redis vs Postgres' });
    expect(parseUserInput('/audit staged focus on auth')).toEqual({
      kind: 'audit',
      mode: 'staged',
      focus: 'focus on auth',
    });
    expect(parseUserInput('/task Fix race condition in ledger')).toEqual({
      kind: 'task',
      description: 'Fix race condition in ledger',
      autoPlan: false,
    });
    expect(parseUserInput('/task --auto-plan Fix race condition in ledger')).toEqual({
      kind: 'task',
      description: 'Fix race condition in ledger',
      autoPlan: true,
    });
    expect(parseUserInput('/approve')).toEqual({ kind: 'approve', id: undefined });
    expect(parseUserInput('/approve plan-123')).toEqual({ kind: 'approve', id: 'plan-123' });
    expect(parseUserInput('/diff')).toEqual({ kind: 'diff', file: undefined });
    expect(parseUserInput('/diff 1')).toEqual({ kind: 'diff', file: '1' });
    expect(parseUserInput('/diff src/index.ts')).toEqual({ kind: 'diff', file: 'src/index.ts' });
    expect(parseUserInput('/warm')).toEqual({ kind: 'warm', action: 'status' });
    expect(parseUserInput('/warm clear')).toEqual({ kind: 'warm', action: 'clear' });
    expect(parseUserInput('/apply')).toEqual({ kind: 'apply', revisionId: undefined });
    expect(parseUserInput('/apply rev-456')).toEqual({ kind: 'apply', revisionId: 'rev-456' });
    expect(parseUserInput('/reject')).toEqual({ kind: 'reject', reason: undefined });
    expect(parseUserInput('/reject Needs tests')).toEqual({ kind: 'reject', reason: 'Needs tests' });
    expect(parseUserInput('hello everyone')).toEqual({ kind: 'plain', body: 'hello everyone' });
  });

  it('suggests matching /commands and @mentions while typing', () => {
    expect(getInputSuggestions('/d', ['claude', 'codex', 'agy'])).toEqual(['/debate ', '/diff ']);
    expect(getInputSuggestions('@c', ['claude', 'codex', 'agy'])).toEqual(['@claude ', '@codex ']);
    expect(getInputSuggestions('/debate already has space', ['claude'])).toEqual([]);
  });
});
