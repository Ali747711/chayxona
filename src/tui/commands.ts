import { isAgentRole, type AgentRole } from '../domain/roles.js';
import type { AgentId } from '../domain/types.js';
import type { AuditMode } from '../orchestrator/git-inspector.js';

export type ParsedCommand =
  | { kind: 'empty' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'agents' }
  | { kind: 'role'; agent?: AgentId; role?: AgentRole; invalid?: string }
  | { kind: 'findings' }
  | { kind: 'summary' }
  | { kind: 'diff' }
  | { kind: 'checks' }
  | { kind: 'pause' }
  | { kind: 'continue' }
  | { kind: 'unseal' }
  | { kind: 'recover'; sub: 'retry' | 'unseal' | 'r2' | 'invalid' }
  | { kind: 'stop'; target: AgentId | 'all' }
  | { kind: 'budget'; delta: number }
  | { kind: 'export'; format: 'md' | 'jsonl' | 'pr'; targetPath?: string }
  | { kind: 'task'; description: string; autoPlan?: boolean }
  | { kind: 'approve'; id?: string }
  | { kind: 'reject'; reason?: string }
  | { kind: 'apply'; revisionId?: string }
  | { kind: 'debate'; topic: string }
  | { kind: 'audit'; mode?: AuditMode; focus: string }
  | { kind: 'unknown_slash'; command: string }
  | { kind: 'mention'; target: AgentId | 'all'; body: string }
  | { kind: 'plain'; body: string };

export function parseUserInput(raw: string): ParsedCommand {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  if (trimmed === '/quit' || trimmed === '/exit') return { kind: 'quit' };
  if (trimmed === '/help') return { kind: 'help' };
  if (trimmed === '/agents' || trimmed === '/agent') return { kind: 'agents' };
  if (trimmed === '/role' || trimmed.startsWith('/role ')) {
    const parts = trimmed.slice(5).trim().split(/\s+/).filter(Boolean);
    const [agentRaw, roleRaw] = parts;
    if (!agentRaw || !roleRaw) {
      return { kind: 'role', invalid: 'Usage: /role <claude|codex|agy> <architect|security|performance|skeptic|reviewer|implementer>' };
    }
    const agent = agentRaw.toLowerCase();
    const role = roleRaw.toLowerCase();
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'agy') {
      return { kind: 'role', invalid: `Unknown agent "${agentRaw}". Use claude, codex, or agy.` };
    }
    if (!isAgentRole(role)) {
      return {
        kind: 'role',
        invalid: `Unknown role "${roleRaw}". Use: architect, security, performance, skeptic, reviewer, implementer.`,
      };
    }
    return { kind: 'role', agent, role };
  }
  if (trimmed === '/findings') return { kind: 'findings' };
  if (trimmed === '/summary') return { kind: 'summary' };
  if (trimmed === '/diff') return { kind: 'diff' };
  if (trimmed === '/checks') return { kind: 'checks' };
  if (trimmed === '/pause') return { kind: 'pause' };
  if (trimmed === '/continue') return { kind: 'continue' };
  if (trimmed === '/unseal') return { kind: 'unseal' };

  if (trimmed === '/recover' || trimmed.startsWith('/recover ')) {
    const sub = trimmed.slice(8).trim().toLowerCase();
    if (sub === 'retry' || sub === 'unseal' || sub === 'r2') return { kind: 'recover', sub };
    return { kind: 'recover', sub: 'invalid' };
  }

  if (trimmed === '/stop' || trimmed.startsWith('/stop ')) {
    const arg = trimmed.slice(5).trim().toLowerCase();
    if (arg === 'claude' || arg === 'codex' || arg === 'agy') return { kind: 'stop', target: arg };
    return { kind: 'stop', target: 'all' };
  }

  if (trimmed === '/budget' || trimmed.startsWith('/budget ')) {
    const m = /^\+?\s*(\d+)$/.exec(trimmed.slice(7).trim());
    return { kind: 'budget', delta: m ? Number.parseInt(m[1], 10) : 12 };
  }

  if (trimmed === '/export' || trimmed.startsWith('/export ')) {
    const parts = trimmed.split(/\s+/).slice(1);
    const format: 'md' | 'jsonl' | 'pr' =
      parts[0] === 'jsonl' ? 'jsonl' : parts[0] === 'pr' ? 'pr' : 'md';
    return { kind: 'export', format, targetPath: parts[1] };
  }

  if (trimmed === '/task' || trimmed.startsWith('/task ')) {
    const rawDesc = trimmed.slice(5).trim();
    const autoPlan = rawDesc.startsWith('--auto-plan');
    const description = autoPlan ? rawDesc.slice(11).trim() : rawDesc;
    return { kind: 'task', description, autoPlan };
  }

  if (trimmed === '/approve' || trimmed.startsWith('/approve ')) {
    const id = trimmed.slice(8).trim() || undefined;
    return { kind: 'approve', id };
  }

  if (trimmed === '/reject' || trimmed.startsWith('/reject ')) {
    const reason = trimmed.slice(7).trim() || undefined;
    return { kind: 'reject', reason };
  }

  if (trimmed === '/apply' || trimmed.startsWith('/apply ')) {
    const revisionId = trimmed.slice(6).trim() || undefined;
    return { kind: 'apply', revisionId };
  }

  if (trimmed === '/debate' || trimmed.startsWith('/debate ')) {
    return { kind: 'debate', topic: trimmed.slice(7).trim() };
  }

  if (trimmed === '/audit' || trimmed.startsWith('/audit ')) {
    const rest = trimmed.slice(6).trim();
    const [first, ...others] = rest ? rest.split(/\s+/) : [];
    const mode: AuditMode | undefined =
      first === 'diff' || first === 'staged' || first === 'head' ? first : undefined;
    return { kind: 'audit', mode, focus: mode ? others.join(' ') : rest };
  }

  // Reject any unrecognized /command so typos NEVER burn agent turns
  if (trimmed.startsWith('/')) {
    const cmd = trimmed.split(/\s+/)[0] ?? trimmed;
    return { kind: 'unknown_slash', command: cmd };
  }

  const mentionMatch = /^@(claude|codex|agy|all)\s+([\s\S]+)$/i.exec(trimmed);
  if (mentionMatch) {
    return {
      kind: 'mention',
      target: mentionMatch[1].toLowerCase() as AgentId | 'all',
      body: mentionMatch[2].trim(),
    };
  }

  return { kind: 'plain', body: trimmed };
}

export const SLASH_COMMANDS: readonly { cmd: string; takesArg: boolean }[] = [
  { cmd: '/debate', takesArg: true },
  { cmd: '/audit', takesArg: true },
  { cmd: '/task', takesArg: true },
  { cmd: '/approve', takesArg: false },
  { cmd: '/reject', takesArg: false },
  { cmd: '/diff', takesArg: false },
  { cmd: '/checks', takesArg: false },
  { cmd: '/apply', takesArg: false },
  { cmd: '/agents', takesArg: false },
  { cmd: '/role', takesArg: true },
  { cmd: '/summary', takesArg: false },
  { cmd: '/findings', takesArg: false },
  { cmd: '/unseal', takesArg: false },
  { cmd: '/budget', takesArg: true },
  { cmd: '/pause', takesArg: false },
  { cmd: '/continue', takesArg: false },
  { cmd: '/recover', takesArg: true },
  { cmd: '/stop', takesArg: true },
  { cmd: '/export', takesArg: true },
  { cmd: '/help', takesArg: false },
  { cmd: '/quit', takesArg: false },
];

export function getInputSuggestions(input: string, agents: readonly AgentId[]): string[] {
  const trimmed = input.trimStart();
  if (!trimmed || /\s/.test(trimmed)) return [];

  if (trimmed.startsWith('/')) {
    const lower = trimmed.toLowerCase();
    return SLASH_COMMANDS
      .filter((c) => c.cmd.startsWith(lower) && c.cmd !== lower)
      .slice(0, 5)
      .map((c) => (c.takesArg ? `${c.cmd} ` : c.cmd));
  }

  if (trimmed.startsWith('@')) {
    const lower = trimmed.toLowerCase();
    const mentions = [...agents.map((a) => `@${a}`), '@all'];
    return mentions
      .filter((m) => m.startsWith(lower) && m !== lower)
      .slice(0, 4)
      .map((m) => `${m} `);
  }

  return [];
}
