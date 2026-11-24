import { describe, expect, it } from 'vitest';
import { ALL_ROLES, DEFAULT_AGENT_ROLES, isAgentRole, ROLE_GUIDANCE } from '../src/domain/roles.js';
import { buildBlindR1Prompt } from '../src/orchestrator/context-builder.js';

describe('agent roles & prompt lens injection', () => {
  it('validates all built-in roles and provides distinct defaults per agent', () => {
    for (const r of ALL_ROLES) {
      expect(isAgentRole(r)).toBe(true);
      expect(ROLE_GUIDANCE[r].length).toBeGreaterThan(20);
    }
    expect(isAgentRole('wizard')).toBe(false);
    expect(DEFAULT_AGENT_ROLES.claude).toBe('architect');
    expect(DEFAULT_AGENT_ROLES.codex).toBe('reviewer');
    expect(DEFAULT_AGENT_ROLES.agy).toBe('skeptic');
  });

  it('injects role lens guidance into Blind Round 1 prompts', () => {
    const prompt = buildBlindR1Prompt({
      agentId: 'codex',
      role: 'security',
      kind: 'debate',
      topic: 'Review auth flow',
      recentHistory: [],
    });
    expect(prompt).toContain('Role lens: SECURITY');
    expect(prompt).toContain('threat modeling');
  });
});
