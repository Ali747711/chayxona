import { describe, expect, it } from 'vitest';
import { groupFindings, parseFindingsFromReply } from '../src/domain/findings.js';

describe('findings parser and aggregator', () => {
  it('strips fenced block, assigns phase-scoped canonical IDs, and validates cross-refs', () => {
    const raw = [
      'Cache-aside breaks read-after-write.',
      '```chayxona-findings',
      JSON.stringify({
        findings: [
          {
            id: 'F1',
            severity: 'high',
            file: 'src/ledger.ts',
            line: '88-92',
            summary: 'Stale balance after transfer',
            evidence: 'getBalance called right after commit',
            agrees_with: ['R1-r1-claude-F1'],
            dissents_from: ['R1-r1-missing-F9'],
          },
          {
            id: 'F1',
            severity: 'low',
            file: null,
            line: null,
            summary: 'Architecture note',
          },
        ],
      }),
      '```',
    ].join('\n');

    const res = parseFindingsFromReply({
      rawText: raw,
      roomId: 'r-1',
      messageId: 'm-1',
      roundId: 1,
      phase: 'r2',
      agentId: 'codex',
      knownCanonicalIds: new Set(['R1-r1-claude-F1']),
    });

    expect(res.cleanProse).toBe('Cache-aside breaks read-after-write.');
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0].canonicalId).toBe('R1-r2-codex-F1');
    expect(res.findings[0].line).toBe(88);
    expect(res.findings[0].evidence).toContain('lines 88-92');
    expect(res.findings[0].agreesWith).toEqual(['R1-r1-claude-F1']);
    expect(res.findings[0].dissentsFrom).toEqual([]);
    expect(res.findings[1].canonicalId).toBe('R1-r2-codex-F1-2');
    expect(res.diagnostics.length).toBeGreaterThanOrEqual(2);

    const grouped = groupFindings(res.findings);
    expect(grouped[0].group).toBe('(General / Architecture)');
    expect(grouped[1].group).toBe('src/ledger.ts');
  });

  it('degrades gracefully on malformed JSON without losing prose', () => {
    const res = parseFindingsFromReply({
      rawText: 'Good analysis.\n```chayxona-findings\n{not json\n```',
      roomId: 'r-1',
      messageId: 'm-1',
      roundId: 1,
      phase: 'r1',
      agentId: 'claude',
      knownCanonicalIds: new Set(),
    });
    expect(res.cleanProse).toBe('Good analysis.');
    expect(res.findings).toHaveLength(0);
    expect(res.diagnostics[0]).toContain('Malformed');
  });
});
