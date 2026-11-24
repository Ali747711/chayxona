import { AgyAdapter } from './agy.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { AgentAdapter } from './contract.js';
import { FakeAgentAdapter } from './fake.js';
import type { AgentId } from '../domain/types.js';
import type { SecretRedactor } from '../security/redactor.js';

export function createAdapters(redactor: SecretRedactor, useFake = false): Map<AgentId, AgentAdapter> {
  if (useFake) {
    return new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAgentAdapter('claude')],
      ['codex', new FakeAgentAdapter('codex')],
      ['agy', new FakeAgentAdapter('agy')],
    ]);
  }
  return new Map<AgentId, AgentAdapter>([
    ['claude', new ClaudeAdapter('claude', redactor)],
    ['codex', new CodexAdapter('codex', redactor)],
    ['agy', new AgyAdapter('agy', redactor)],
  ]);
}
