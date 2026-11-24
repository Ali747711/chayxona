import type { AgentAdapter } from './contract.js';
import { resolveExecutable, runQuickProbe } from './probe-util.js';
import { runSubprocessLines } from './process-runner.js';
import type { AgentEvent, ProviderCapabilities, TurnInput } from '../domain/types.js';
import { SecretRedactor } from '../security/redactor.js';

export function buildAgyReadOnlyArgs(prompt: string, timeoutMs: number): string[] {
  const timeoutSec = Math.max(10, Math.ceil(timeoutMs / 1000));
  return [
    '--output-format',
    'stream-json',
    '--sandbox',
    '--disable-slash-commands',
    '--print-timeout',
    `${timeoutSec}s`,
    '-p',
    prompt,
  ];
}

export function parseAgyJsonlLine(
  line: string,
  base: { roomId: string; roundId: number; turnId: string; agentId: 'agy' },
  state: { finalText: string | null; textParts: string[]; inputTokens: number | null; outputTokens: number | null; error: string | null },
): AgentEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ ...base, type: 'provider.warning', message: 'Skipped malformed JSONL line from agy', ts: Date.now() }];
  }

  const events: AgentEvent[] = [];
  const evName = String(obj.event ?? obj.type ?? '');

  if (evName === 'init' && typeof obj.conversation_id === 'string' && obj.conversation_id) {
    events.push({ ...base, type: 'session.bound', externalSessionId: obj.conversation_id, ts: Date.now() });
    return events;
  }

  if (evName === 'step_update') {
    const step = obj.step_update as Record<string, unknown> | undefined;
    const toolName = typeof step?.tool_name === 'string' ? step.tool_name : null;
    if (toolName) {
      events.push({ ...base, type: 'tool.started', toolName, summary: toolName, ts: Date.now() });
    }
    const delta = typeof step?.text === 'string' ? step.text : typeof step?.response === 'string' ? step.response : null;
    if (delta) {
      state.textParts.push(delta);
      events.push({ ...base, type: 'text.delta', delta, ts: Date.now() });
    }
    return events;
  }

  if (evName === 'result') {
    const result = obj.result as Record<string, unknown> | undefined;
    if (typeof result?.conversation_id === 'string' && result.conversation_id) {
      events.push({ ...base, type: 'session.bound', externalSessionId: result.conversation_id, ts: Date.now() });
    }
    if (result?.status === 'ERROR') {
      state.error = typeof result.error === 'string' ? result.error : 'agy reported ERROR status';
    }
    if (typeof result?.response === 'string' && result.response.length > 0) {
      state.finalText = result.response;
    }
    const usage = result?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (typeof usage?.input_tokens === 'number') state.inputTokens = usage.input_tokens;
    if (typeof usage?.output_tokens === 'number') state.outputTokens = usage.output_tokens;
    return events;
  }

  return events;
}

export class AgyAdapter implements AgentAdapter {
  readonly id = 'agy' as const;

  constructor(
    private readonly command = 'agy',
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
    const hasSandbox = helpText.includes('--sandbox');
    const hasStreamJson = helpText.includes('stream-json');

    return {
      id: this.id,
      available: true,
      executablePath: exe,
      version: ver.stdout.trim().split('\n')[0] || null,
      readOnlySupported: hasSandbox,
      readOnlyProfile: hasSandbox ? '--output-format stream-json --sandbox --disable-slash-commands -p <prompt>' : null,
      streamingSupported: hasStreamJson,
      authStatus: 'unknown',
      error: hasSandbox ? undefined : 'Antigravity CLI missing --sandbox read-only support',
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
    const state = {
      finalText: null as string | null,
      textParts: [] as string[],
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      error: null as string | null,
    };

    const push = (ev: AgentEvent): void => {
      queue.push(ev);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    };

    // Cap prompt argument well below ARG_MAX (64KB)
    const boundedPrompt = input.prompt.length > 60_000 ? `${input.prompt.slice(0, 60_000)}\n[prompt truncated]` : input.prompt;

    const runPromise = runSubprocessLines({
      command: this.command,
      args: buildAgyReadOnlyArgs(boundedPrompt, input.timeoutMs),
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal,
      redactor: this.redactor,
      onLine: (line) => {
        for (const ev of parseAgyJsonlLine(line, base, state)) {
          push(ev);
        }
      },
    }).then((res) => {
      if (res.cancelled) {
        push({ ...base, type: 'turn.cancelled', ts: Date.now() });
      } else if (res.errorCode || state.error) {
        push({
          ...base,
          type: 'turn.failed',
          errorCode: res.errorCode ?? 'protocol_error',
          message: state.error ?? (res.stderr.trim() || `agy exited with code ${res.exitCode ?? 'unknown'}`),
          ts: Date.now(),
        });
      } else {
        const text = state.finalText ?? state.textParts.join('\n').trim();
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
