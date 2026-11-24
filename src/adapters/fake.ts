import type { AgentAdapter } from './contract.js';
import type { AdapterErrorCode, AgentEvent, AgentId, ProviderCapabilities, TurnInput } from '../domain/types.js';

export interface FakeTurnScript {
  chunks?: string[];
  delayMs?: number;
  tools?: Array<{ name: string; summary: string; ok?: boolean }>;
  failWith?: { errorCode: AdapterErrorCode; message: string };
  hangUntilAbort?: boolean;
  sessionId?: string;
}

export type FakeTurnHandler = (input: TurnInput) => FakeTurnScript;

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: AgentId;
  private readonly handler: FakeTurnHandler;
  private readonly available: boolean;

  constructor(id: AgentId, handler?: FakeTurnHandler, available = true) {
    this.id = id;
    this.available = available;
    this.handler =
      handler ??
      ((input) => ({
        delayMs: 10,
        chunks: [
          `[${id}] Reviewed prompt (${input.prompt.slice(0, 48).replace(/\s+/g, ' ')}...).\n`,
          '```chayxona-findings\n',
          JSON.stringify({
            findings: [
              {
                id: 'F1',
                severity: 'medium',
                file: 'src/app.ts',
                line: 12,
                summary: `${id} spotted a potential edge case`,
                evidence: 'Observed in fake fixture',
                agrees_with: [],
                dissents_from: [],
              },
            ],
          }),
          '\n```',
        ],
      }));
  }

  async probe(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: this.available,
      executablePath: this.available ? `/fake/bin/${this.id}` : null,
      version: this.available ? 'fake-1.0.0' : null,
      readOnlySupported: this.available,
      readOnlyProfile: this.available ? 'fake-read-only' : null,
      streamingSupported: this.available,
      authStatus: this.available ? 'authenticated' : 'unauthenticated',
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
    const script = this.handler(input);

    const sessionId = input.resumeSessionId ?? script.sessionId;
    if (sessionId) {
      yield { ...base, type: 'session.bound', externalSessionId: sessionId, ts: Date.now() };
    }

    if (script.hangUntilAbort) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const timeout = setTimeout(resolve, input.timeoutMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) {
        yield { ...base, type: 'turn.cancelled', ts: Date.now() };
      } else {
        yield { ...base, type: 'turn.failed', errorCode: 'timeout', message: 'Turn timed out', ts: Date.now() };
      }
      return;
    }

    for (const tool of script.tools ?? []) {
      if (signal.aborted) {
        yield { ...base, type: 'turn.cancelled', ts: Date.now() };
        return;
      }
      yield { ...base, type: 'tool.started', toolName: tool.name, summary: tool.summary, ts: Date.now() };
      const okSleep = await sleep(script.delayMs ?? 5, signal);
      if (!okSleep) {
        yield { ...base, type: 'turn.cancelled', ts: Date.now() };
        return;
      }
      yield {
        ...base,
        type: 'tool.completed',
        toolName: tool.name,
        ok: tool.ok ?? true,
        summary: tool.summary,
        ts: Date.now(),
      };
    }

    if (script.failWith) {
      yield {
        ...base,
        type: 'turn.failed',
        errorCode: script.failWith.errorCode,
        message: script.failWith.message,
        ts: Date.now(),
      };
      return;
    }

    let fullText = '';
    for (const chunk of script.chunks ?? ['OK']) {
      const okSleep = await sleep(script.delayMs ?? 5, signal);
      if (!okSleep) {
        yield { ...base, type: 'turn.cancelled', ts: Date.now() };
        return;
      }
      fullText += chunk;
      yield { ...base, type: 'text.delta', delta: chunk, ts: Date.now() };
    }

    yield { ...base, type: 'text.completed', text: fullText, ts: Date.now() };
    yield {
      ...base,
      type: 'turn.completed',
      text: fullText,
      inputTokens: 120,
      outputTokens: 64,
      ts: Date.now(),
    };
  }
}
