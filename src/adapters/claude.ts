import type { AgentAdapter } from './contract.js';
import { resolveExecutable, runQuickProbe } from './probe-util.js';
import { runSubprocessLines } from './process-runner.js';
import type { AgentEvent, ProviderCapabilities, TurnInput } from '../domain/types.js';
import { SecretRedactor } from '../security/redactor.js';

export const CLAUDE_READONLY_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  'Read,Glob,Grep',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources',
  '',
] as const;

export const CLAUDE_WRITE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  'Read,Glob,Grep,Edit,Write',
  '--permission-mode',
  'acceptEdits',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources',
  '',
] as const;

export function parseClaudeJsonlLine(
  line: string,
  base: { roomId: string; roundId: number; turnId: string; agentId: 'claude' },
  state: { textParts: string[]; finalText: string | null; inputTokens: number | null; outputTokens: number | null },
): AgentEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ ...base, type: 'provider.warning', message: 'Skipped malformed JSONL line from claude', ts: Date.now() }];
  }

  const events: AgentEvent[] = [];
  const type = String(obj.type ?? '');

  if (type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
    events.push({ ...base, type: 'session.bound', externalSessionId: obj.session_id, ts: Date.now() });
    return events;
  }

  if (type === 'assistant') {
    const message = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
        events.push({
          ...base,
          type: 'tool.started',
          toolName: block.name,
          summary: `${block.name} ${input}`.trim(),
          ts: Date.now(),
        });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        state.textParts.push(block.text);
        events.push({ ...base, type: 'text.delta', delta: block.text, ts: Date.now() });
      }
    }
    return events;
  }

  if (type === 'result') {
    if (typeof obj.result === 'string' && obj.result.length > 0) {
      state.finalText = obj.result;
    }
    const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (typeof usage?.input_tokens === 'number') state.inputTokens = usage.input_tokens;
    if (typeof usage?.output_tokens === 'number') state.outputTokens = usage.output_tokens;
    return events;
  }

  return events;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;

  constructor(
    private readonly command = 'claude',
    private readonly redactor = new SecretRedactor(),
  ) {}

  async probe(): Promise<ProviderCapabilities> {
    const exe = await resolveExecutable(this.command);
    if (!exe) {
      return {
        id: this.id,
        available: false,
        executablePath: null,
        version: null,
        readOnlySupported: false,
        readOnlyProfile: null,
        streamingSupported: false,
        authStatus: 'unknown',
        error: `Executable "${this.command}" not found in PATH`,
      };
    }

    const ver = await runQuickProbe(exe, ['--version']);
    const help = await runQuickProbe(exe, ['--help']);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const hasTools = helpText.includes('--tools');
    const hasStrictMcp = helpText.includes('--strict-mcp-config');
    const hasStreamJson = helpText.includes('stream-json');
    const readOnlySupported = hasTools && hasStrictMcp;

    return {
      id: this.id,
      available: true,
      executablePath: exe,
      version: ver.stdout.trim().split('\n')[0] || null,
      readOnlySupported,
      readOnlyProfile: readOnlySupported ? '--tools Read,Glob,Grep --strict-mcp-config --disable-slash-commands' : null,
      streamingSupported: hasStreamJson,
      authStatus: 'unknown',
      error: readOnlySupported ? undefined : 'CLI missing --tools or --strict-mcp-config for strict read-only isolation',
    };
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const base = {
      roomId: input.roomId,
      roundId: input.roundId,
      turnId: input.turnId,
      agentId: this.id,
    };
    yield { ...base, type: 'turn.started', ts: Date.now() };

    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const state = { textParts: [] as string[], finalText: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null };

    const push = (ev: AgentEvent): void => {
      queue.push(ev);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    };

    const args = input.permissions === 'workspace-write' ? [...CLAUDE_WRITE_ARGS] : [...CLAUDE_READONLY_ARGS];
    const runPromise = runSubprocessLines({
      command: this.command,
      args,
      cwd: input.cwd,
      stdinText: input.prompt,
      timeoutMs: input.timeoutMs,
      signal,
      redactor: this.redactor,
      onLine: (line) => {
        for (const ev of parseClaudeJsonlLine(line, base, state)) {
          push(ev);
        }
      },
    }).then((res) => {
      if (res.cancelled) {
        push({ ...base, type: 'turn.cancelled', ts: Date.now() });
      } else if (res.errorCode) {
        push({
          ...base,
          type: 'turn.failed',
          errorCode: res.errorCode,
          message: res.stderr.trim() || `claude exited with code ${res.exitCode ?? 'unknown'}`,
          ts: Date.now(),
        });
      } else {
        const text = state.finalText ?? state.textParts.join('\n');
        push({ ...base, type: 'text.completed', text, ts: Date.now() });
        push({
          ...base,
          type: 'turn.completed',
          text,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          ts: Date.now(),
        });
      }
      done = true;
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    });

    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    }
    await runPromise;
  }
}
