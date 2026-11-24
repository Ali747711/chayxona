import { describe, expect, it } from 'vitest';
import { parseAgyJsonlLine } from '../src/adapters/agy.js';
import { parseClaudeJsonlLine } from '../src/adapters/claude.js';
import { parseCodexJsonlLine } from '../src/adapters/codex.js';
import { runSubprocessLines } from '../src/adapters/process-runner.js';
import { SecretRedactor } from '../src/security/redactor.js';

describe('adapter JSONL parsers & process-runner', () => {
  it('parses claude, codex, and agy fixture events and survives malformed lines', () => {
    const claudeState = { textParts: [] as string[], finalText: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null };
    const cBase = { roomId: 'r1', roundId: 1, turnId: 't1', agentId: 'claude' as const };
    expect(parseClaudeJsonlLine('{"type":"system","subtype":"init","session_id":"s-1"}', cBase, claudeState)[0].type).toBe('session.bound');
    expect(parseClaudeJsonlLine('not-json', cBase, claudeState)[0].type).toBe('provider.warning');
    parseClaudeJsonlLine('{"type":"result","result":"done","usage":{"input_tokens":10,"output_tokens":5}}', cBase, claudeState);
    expect(claudeState.finalText).toBe('done');

    const codexState = { textParts: [] as string[], inputTokens: null as number | null, outputTokens: null as number | null };
    const xBase = { roomId: 'r1', roundId: 1, turnId: 't2', agentId: 'codex' as const };
    expect(parseCodexJsonlLine('{"type":"thread.started","thread_id":"th-1"}', xBase, codexState)[0].type).toBe('session.bound');
    parseCodexJsonlLine('{"type":"item.completed","item":{"type":"agent_message","text":"hello codex"}}', xBase, codexState);
    expect(codexState.textParts).toEqual(['hello codex']);

    const agyState = { finalText: null as string | null, textParts: [] as string[], inputTokens: null as number | null, outputTokens: null as number | null, error: null as string | null };
    const aBase = { roomId: 'r1', roundId: 1, turnId: 't3', agentId: 'agy' as const };
    expect(parseAgyJsonlLine('{"event":"init","conversation_id":"conv-1"}', aBase, agyState)[0].type).toBe('session.bound');
    parseAgyJsonlLine('{"event":"result","result":{"status":"SUCCESS","response":"hello agy","usage":{"input_tokens":20,"output_tokens":8}}}', aBase, agyState);
    expect(agyState.finalText).toBe('hello agy');
  });

  it('reaps detached child process group on AbortSignal within 2s', async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    const res = await runSubprocessLines({
      command: process.execPath,
      args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: ac.signal,
      redactor: new SecretRedactor({}),
      graceMs: 200,
      onLine: (l) => lines.push(l),
    });
    const elapsed = Date.now() - t0;
    expect(res.cancelled).toBe(true);
    expect(res.errorCode).toBe('cancelled');
    expect(elapsed).toBeLessThan(2000);
  });
});
