import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AgentId, FindingRecord, FindingSeverity } from './types.js';

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const LineSchema = z
  .union([z.number().int().positive(), z.string(), z.null(), z.undefined()])
  .transform((val): { line: number | null; rangeNote: string | null } => {
    if (val === null || val === undefined) return { line: null, rangeNote: null };
    if (typeof val === 'number') return { line: val, rangeNote: null };
    const trimmed = val.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(trimmed);
    if (!match) return { line: null, rangeNote: null };
    const start = Number.parseInt(match[1], 10);
    return { line: start, rangeNote: match[2] ? `lines ${match[1]}-${match[2]}` : null };
  });

const RawFindingSchema = z.object({
  id: z.string().min(1).max(32),
  severity: SeveritySchema,
  file: z.string().min(1).nullable().optional().default(null),
  line: LineSchema,
  summary: z.string().min(1).max(500),
  evidence: z.string().max(2000).optional().default(''),
  agrees_with: z.array(z.string()).optional().default([]),
  dissents_from: z.array(z.string()).optional().default([]),
});

const FindingsBlockSchema = z.object({
  findings: z.array(RawFindingSchema).max(50),
});

export interface ParsedFindingsResult {
  cleanProse: string;
  findings: FindingRecord[];
  diagnostics: string[];
}

const FENCED_BLOCK_RE = /```(?:chayxona-findings|quorum-findings)\s*\n([\s\S]*?)```/gi;

/**
 * Extracts and validates the optional fenced `chayxona-findings` JSON block,
 * strips it from transcript prose, assigns collision-free phase-scoped canonical IDs
 * (`R<roundId>-<r1|r2|freeform>-<agentId>-<localId>`), and validates cross-references.
 */
export function parseFindingsFromReply(opts: {
  rawText: string;
  roomId: string;
  messageId: string;
  roundId: number;
  phase: 'r1' | 'r2' | 'freeform';
  agentId: AgentId;
  knownCanonicalIds: ReadonlySet<string>;
  now?: number;
}): ParsedFindingsResult {
  const { rawText, roomId, messageId, roundId, phase, agentId, knownCanonicalIds } = opts;
  const now = opts.now ?? Date.now();
  const diagnostics: string[] = [];
  const findings: FindingRecord[] = [];

  const matches = [...rawText.matchAll(FENCED_BLOCK_RE)];
  if (matches.length === 0) {
    return { cleanProse: rawText.trim(), findings: [], diagnostics: [] };
  }

  // Use the last fenced block if multiple appeared; strip all fenced findings blocks from prose
  const lastMatch = matches[matches.length - 1];
  const jsonText = lastMatch[1].trim();
  const cleanProse = rawText.replace(FENCED_BLOCK_RE, '').trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    diagnostics.push(
      `Malformed chayxona-findings JSON from ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { cleanProse, findings: [], diagnostics };
  }

  const validated = FindingsBlockSchema.safeParse(parsedJson);
  if (!validated.success) {
    diagnostics.push(
      `Invalid chayxona-findings schema from ${agentId}: ${validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    return { cleanProse, findings: [], diagnostics };
  }

  const seenLocalIds = new Map<string, number>();

  for (const item of validated.data.findings) {
    const count = (seenLocalIds.get(item.id) ?? 0) + 1;
    seenLocalIds.set(item.id, count);
    const localKey = count === 1 ? item.id : `${item.id}-${count}`;
    if (count > 1) {
      diagnostics.push(`Duplicate local finding ID "${item.id}" from ${agentId}; renamed to "${localKey}"`);
    }

    const canonicalId = `R${roundId}-${phase}-${agentId}-${localKey}`;

    const agreesWith: string[] = [];
    for (const ref of item.agrees_with) {
      if (knownCanonicalIds.has(ref)) {
        agreesWith.push(ref);
      } else {
        diagnostics.push(`Dropped dangling agrees_with reference "${ref}" from ${canonicalId}`);
      }
    }

    const dissentsFrom: string[] = [];
    for (const ref of item.dissents_from) {
      if (knownCanonicalIds.has(ref)) {
        dissentsFrom.push(ref);
      } else {
        diagnostics.push(`Dropped dangling dissents_from reference "${ref}" from ${canonicalId}`);
      }
    }

    const lineInfo = item.line ?? { line: null, rangeNote: null };
    const evidence = lineInfo.rangeNote
      ? `${lineInfo.rangeNote}${item.evidence ? `: ${item.evidence}` : ''}`
      : item.evidence;

    findings.push({
      id: randomUUID(),
      roomId,
      messageId,
      roundId,
      phase,
      agentId,
      canonicalId,
      severity: item.severity as FindingSeverity,
      file: item.file ?? null,
      line: lineInfo.line,
      summary: item.summary,
      evidence,
      agreesWith,
      dissentsFrom,
      createdAt: now,
    });
  }

  return { cleanProse, findings, diagnostics };
}

export interface GroupedFindings {
  group: string; // file path or '(General / Architecture)'
  items: FindingRecord[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function groupFindings(findings: readonly FindingRecord[]): GroupedFindings[] {
  const byGroup = new Map<string, FindingRecord[]>();
  for (const f of findings) {
    const key = f.file ?? '(General / Architecture)';
    const arr = byGroup.get(key) ?? [];
    arr.push(f);
    byGroup.set(key, arr);
  }

  const groups: GroupedFindings[] = [];
  for (const [group, items] of byGroup.entries()) {
    items.sort((a, b) => {
      const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) return lineA - lineB;
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    });
    groups.push({ group, items });
  }

  groups.sort((a, b) => {
    if (a.group === '(General / Architecture)') return -1;
    if (b.group === '(General / Architecture)') return 1;
    return a.group.localeCompare(b.group);
  });

  return groups;
}
