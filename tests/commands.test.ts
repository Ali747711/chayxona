import { describe, expect, it } from 'vitest';
import { parseUserInput } from '../src/tui/commands.js';

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
    expect(parseUserInput('hello everyone')).toEqual({ kind: 'plain', body: 'hello everyone' });
  });
});
