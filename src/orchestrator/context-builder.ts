import type { AgentId, FindingRecord, MessageRecord } from '../domain/types.js';
import type { AuditPayload } from './git-inspector.js';

const MAX_R1_TAKE_BYTES = 8 * 1024;

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${sliced}\n[truncated to ${maxBytes} bytes]`;
}

const FINDINGS_INSTRUCTION = `
At the end of your response, optionally include a fenced \`chayxona-findings\` JSON block for structured issues/dissent:
\`\`\`chayxona-findings
{
  "findings": [
    {
      "id": "F1",
      "severity": "critical|high|medium|low|info",
      "file": "path/to/file.ts or null",
      "line": 42,
      "summary": "Concise issue or architectural point",
      "evidence": "Specific code/symbol/behavior observed",
      "agrees_with": [],
      "dissents_from": []
    }
  ]
}
\`\`\``;

export function buildBlindR1Prompt(opts: {
  agentId: AgentId;
  kind: 'debate' | 'audit';
  topic: string;
  audit?: AuditPayload;
  recentHistory: readonly MessageRecord[];
}): string {
  const lines: string[] = [
    `You are ${opts.agentId.toUpperCase()} participating in a READ-ONLY Chayxona engineering room.`,
    'You are in BLIND ROUND 1: inspect the repository independently. Do NOT assume what other agents think.',
    'Do NOT attempt to modify files or run mutating commands.',
  ];

  // Exclude any sealed or active-blind messages defensively (already filtered by caller)
  const safeHistory = opts.recentHistory.filter((m) => !m.sealed && m.roundPhase !== 'blind_r1');
  if (safeHistory.length > 0) {
    lines.push('\n## Prior Room Context (last messages)');
    for (const m of safeHistory.slice(-12)) {
      lines.push(`[${m.sender.toUpperCase()}]: ${truncateBytes(m.body, 1500)}`);
    }
  }

  if (opts.kind === 'audit' && opts.audit) {
    lines.push(`\n## Audit Target (${opts.audit.mode})`);
    if (opts.audit.disclaimer) {
      lines.push(`NOTE: ${opts.audit.disclaimer}`);
    }
    if (opts.audit.stat) {
      lines.push('### git stat\n```text\n' + opts.audit.stat + '\n```');
    }
    if (opts.audit.patch) {
      lines.push('### patch\n```diff\n' + opts.audit.patch + '\n```');
    }
    if (opts.audit.truncated) {
      lines.push('NOTE: Patch was truncated at 32KB; you may inspect omitted files with your read-only file tools.');
    }
    lines.push(`\n## Task\nIndependently audit these changes for bugs, races, security flaws, and missing edge cases. ${opts.topic ? `Focus: ${opts.topic}` : ''}`);
  } else {
    lines.push(`\n## Debate Topic\n${opts.topic}`);
    lines.push('\nInspect relevant files in the repository, take a concrete position, and call out edge cases or failure modes.');
  }

  lines.push(FINDINGS_INSTRUCTION);
  return lines.join('\n');
}

export function buildCrossExamR2Prompt(opts: {
  agentId: AgentId;
  roundId: number;
  topic: string;
  r1Messages: readonly MessageRecord[];
  r1Findings: readonly FindingRecord[];
  steeringNotes: readonly MessageRecord[];
}): string {
  const lines: string[] = [
    `You are ${opts.agentId.toUpperCase()} in CROSS-EXAMINATION ROUND 2 of a READ-ONLY Chayxona room.`,
    `Topic: ${opts.topic}`,
    'Below are all independent Round 1 takes from the room. Challenge weak assumptions, point out blind spots, and explicitly cite Round 1 finding IDs in agrees_with / dissents_from.',
    '\n## Revealed Round 1 Takes',
  ];

  for (const m of opts.r1Messages) {
    lines.push(`\n### ${m.sender.toUpperCase()}`);
    lines.push(truncateBytes(m.body, MAX_R1_TAKE_BYTES));
  }

  if (opts.r1Findings.length > 0) {
    lines.push('\n## Round 1 Canonical Finding IDs (use these exact IDs in agrees_with / dissents_from)');
    for (const f of opts.r1Findings) {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'General';
      lines.push(`- ${f.canonicalId} [${f.severity.toUpperCase()}] (${loc}): ${f.summary}`);
    }
  }

  if (opts.steeringNotes.length > 0) {
    lines.push('\n## Human Steering Notes (queued during Round 1 — address these directly)');
    for (const note of opts.steeringNotes) {
      lines.push(`- ${note.body}`);
    }
  }

  lines.push(FINDINGS_INSTRUCTION);
  return lines.join('\n');
}

export function buildFreeformPrompt(opts: {
  agentId: AgentId;
  humanMessage: string;
  recentHistory: readonly MessageRecord[];
}): string {
  const lines: string[] = [
    `You are ${opts.agentId.toUpperCase()} in a READ-ONLY Chayxona engineering room.`,
    'Answer concisely and concretely based on the repository and prior room context. Do NOT mutate files.',
  ];

  const safeHistory = opts.recentHistory.filter((m) => !m.sealed && m.roundPhase !== 'blind_r1');
  if (safeHistory.length > 0) {
    lines.push('\n## Recent Room History');
    for (const m of safeHistory.slice(-12)) {
      lines.push(`[${m.sender.toUpperCase()}]: ${truncateBytes(m.body, 1500)}`);
    }
  }

  lines.push(`\n## Human Message\n${opts.humanMessage}`);
  lines.push(FINDINGS_INSTRUCTION);
  return lines.join('\n');
}
