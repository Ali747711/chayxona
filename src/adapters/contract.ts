import type { AgentEvent, AgentId, ProviderCapabilities, TurnInput } from '../domain/types.js';

export interface AgentAdapter {
  readonly id: AgentId;
  probe(): Promise<ProviderCapabilities>;
  run(input: TurnInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
