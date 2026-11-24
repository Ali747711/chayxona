import type { AgentId } from './types.js';

export type AgentRole = 'architect' | 'security' | 'performance' | 'skeptic' | 'reviewer' | 'implementer';

export const ALL_ROLES: readonly AgentRole[] = [
  'architect',
  'security',
  'performance',
  'skeptic',
  'reviewer',
  'implementer',
] as const;

export const DEFAULT_AGENT_ROLES: Record<AgentId, AgentRole> = {
  claude: 'architect',
  codex: 'reviewer',
  agy: 'skeptic',
};

export const ROLE_GUIDANCE: Record<AgentRole, string> = {
  architect:
    'Focus on system boundaries, data flow, state-machine invariants, coupling, and long-term maintainability.',
  security:
    'Focus on threat modeling, auth/permission bypasses, path traversal, command/prompt injection, race conditions, and secret exposure.',
  performance:
    'Focus on latency bottlenecks, N+1 queries, memory growth, lock contention, streaming backpressure, and algorithmic complexity.',
  skeptic:
    'Challenge hidden assumptions, invert failure modes ("how does this break in production?"), and question unnecessary complexity.',
  reviewer:
    'Focus on code correctness, subtle edge cases, error paths, crash recovery, and missing test coverage.',
  implementer:
    'Focus on pragmatic execution, minimal clean diffs, concrete file-level changes, and clear verification steps.',
};

export function isAgentRole(value: string): value is AgentRole {
  return (ALL_ROLES as readonly string[]).includes(value);
}
