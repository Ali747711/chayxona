import type { AgentAdapter } from './contract.js';
import { resolveExecutable, runQuickProbe } from './probe-util.js';
import { runSubprocessLines } from './process-runner.js';
import type { AgentEvent, ProviderCapabilities, TurnInput } from '../domain/types.js';
import { SecretRedactor } from '../security/redactor.js';

export const CODEX_READONLY_ARGS = [
  'exec',
  '--json',
  '-s',
  'read-only',
  '--skip-git-repo-check',
  '-',
] as const;

export const CODEX_WRITE_ARGS = [
  'exec',
  '--json',
  '-s',
  'workspace-write',
  '--skip-git-repo-check',
  '-',
] as const;

export function parseCodexJsonlLine(
  line: string,
  base: { roomId: string; roundId: number; turnId: string; agentId: 'codex' },
  state: { textParts: string[]; inputTokens: number | null; outputTokens: number | null },
): AgentEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ ...base, type: 'provider.warning', message: 'Skipped malformed JSONL line from codex', ts: Date.now() }];
  }

  const events: AgentEvent[] = [];
  const type = String(obj.type ?? '');

  if (type === 'thread.started' && typeof obj.thread_id === 'string') {
    events.push({ ...base, type: 'session.bound', externalSessionId: obj.thread_id, ts: Date.now() });
    return events;
  }

  if (type === 'item.started' || type === 'item.completed') {
    const item = obj.item as Record<string, unknown> | undefined;
    const itemType = String(item?.type ?? '');
    if (itemType === 'command_execution') {
      const cmd = typeof item?.command === 'string' ? item.command.slice(0, 180) : 'command';
      if (type === 'item.started') {
        events.push({ ...base, type: 'tool.started', toolName: 'shell(ro)', summary: cmd, ts: Date.now() });
      } else {
        const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : 0;
        events.push({
          ...base,
          type: 'tool.completed',
          toolName: 'shell(ro)',
          ok: exitCode === 0,
          summary: cmd,
          ts: Date.now(),
        });
      }
    } else if (type === 'item.completed' && itemType === 'agent_message' && typeof item?.text === 'string') {
      state.textParts.push(item.text);
      events.push({ ...base, type: 'text.delta', delta: item.text, ts: Date.now() });
    }
    return events;
  }

  if (type === 'turn.completed') {
    const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (typeof usage?.input_tokens === 'number') state.inputTokens = usage.input_tokens;
    if (typeof usage?.output_tokens === 'number') state.outputTokens = usage.output_tokens;
    return events;
  }

  return events;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;

  constructor(
    private readonly command = 'codex',
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
    const help = await runQuickProbe(exe, ['exec', '--help']);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const hasSandbox = helpText.includes('--sandbox');
    const hasJson = helpText.includes('--json');

    return {
      id: this.id,
      available: true,
      executablePath: exe,
      version: ver.stdout.trim().split('\n')[0] || null,
      readOnlySupported: hasSandbox,
      readOnlyProfile: hasSandbox ? 'exec --json -s read-only --skip-git-repo-check -' : null,
      streamingSupported: hasJson,
      authStatus: 'unknown',
      error: hasSandbox ? undefined : 'Codex CLI missing --sandbox read-only support',
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
    const state = { textParts: [] as string[], inputTokens: null as number | null, outputTokens: null as number | null };

    const push = (ev: AgentEvent): void => {
      queue.push(ev);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    };

    const args = input.permissions === 'workspace-write' ? [...CODEX_WRITE_ARGS] : [...CODEX_READONLY_ARGS];
    const runPromise = runSubprocessLines({
      command: this.command,
      args,
      cwd: input.cwd,
      stdinText: input.prompt,
      timeoutMs: input.timeoutMs,
      signal,
      redactor: this.redactor,
      onLine: (line) => {
        for (const ev of parseCodexJsonlLine(line, base, state)) {
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
          message: res.stderr.trim() || `codex exited with code ${res.exitCode ?? 'unknown'}`,
          ts: Date.now(),
        });
      } else {
        const text = state.textParts.join('\n\n').trim();
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
