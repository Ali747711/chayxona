import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPrDebateTopic,
  CHAYXONA_PR_MARKER,
  evaluatePrExitCode,
  hasAvailableVendorKeys,
  resolvePrNumber,
  resolveRepoSlug,
} from '../src/cli/pr-review.js';
import type { FindingRecord } from '../src/domain/types.js';
import { SecretRedactor } from '../src/security/redactor.js';

describe('GitHub PR review topic builder', () => {
  it('formats PR metadata, redacts secrets, and truncates oversized diffs cleanly', () => {
    const topic = buildPrDebateTopic(
      {
        number: 42,
        title: 'Add Redis cache',
        body: 'Uses token sk-proj-1234567890abcdef123456 in tests',
        url: 'https://github.com/Ali747711/chayxona/pull/42',
        baseRefName: 'main',
        headRefName: 'feat/redis',
        diff: [
          'diff --git a/a.ts b/a.ts\n+export const a = 1;\n',
          'diff --git a/big.ts b/big.ts\n' + '+line\n'.repeat(2000),
        ].join('\n'),
      },
      new SecretRedactor({}),
      1024,
    );

    expect(topic).toContain('Review GitHub PR #42: Add Redis cache');
    expect(topic).toContain('feat/redis -> main');
    expect(topic).not.toContain('sk-proj-');
    expect(topic).toContain('[REDACTED]');
    expect(topic).toContain('PR diff truncated');
  });
});

describe('resolvePrNumber', () => {
  it('returns explicit PR number argument when supplied', () => {
    expect(resolvePrNumber('99', {})).toBe('99');
    expect(resolvePrNumber('  101  ', {})).toBe('101');
  });

  it('reads PR number from GITHUB_EVENT_PATH (pull_request event)', () => {
    const tmpFile = path.join(os.tmpdir(), `gh-event-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify({ pull_request: { number: 77 } }), 'utf8');
      const resolved = resolvePrNumber(undefined, { GITHUB_EVENT_PATH: tmpFile });
      expect(resolved).toBe('77');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('reads PR number from GITHUB_EVENT_PATH (issue event fallback)', () => {
    const tmpFile = path.join(os.tmpdir(), `gh-event-issue-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify({ issue: { number: 88 } }), 'utf8');
      const resolved = resolvePrNumber(undefined, { GITHUB_EVENT_PATH: tmpFile });
      expect(resolved).toBe('88');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('reads PR number from GITHUB_REF (refs/pull/<num>/merge)', () => {
    const resolved = resolvePrNumber(undefined, {
      GITHUB_REF: 'refs/pull/123/merge',
    });
    expect(resolved).toBe('123');
  });

  it('throws descriptive error if PR number cannot be resolved', () => {
    expect(() => resolvePrNumber(undefined, {})).toThrow(
      'Could not determine PR number. Pass PR number as an argument or run within a GitHub pull_request workflow.',
    );
  });
});

describe('resolveRepoSlug', () => {
  it('resolves repo slug from GITHUB_REPOSITORY env var', () => {
    const slug = resolveRepoSlug(process.cwd(), {
      GITHUB_REPOSITORY: 'Ali747711/chayxona',
    });
    expect(slug).toEqual({ owner: 'Ali747711', repo: 'chayxona' });
  });

  it('falls back to git origin when GITHUB_REPOSITORY is absent', () => {
    const slug = resolveRepoSlug(process.cwd(), {});
    expect(slug.owner).toBeTruthy();
    expect(slug.repo).toBeTruthy();
  });
});

describe('hasAvailableVendorKeys', () => {
  it('returns true when any vendor key is present', () => {
    expect(hasAvailableVendorKeys({ ANTHROPIC_API_KEY: 'test-key' })).toBe(true);
    expect(hasAvailableVendorKeys({ OPENAI_API_KEY: 'test-key' })).toBe(true);
    expect(hasAvailableVendorKeys({ GEMINI_API_KEY: 'test-key' })).toBe(true);
    expect(hasAvailableVendorKeys({ GOOGLE_API_KEY: 'test-key' })).toBe(true);
  });

  it('returns false when no vendor keys are present', () => {
    expect(hasAvailableVendorKeys({})).toBe(false);
    expect(
      hasAvailableVendorKeys({
        GITHUB_TOKEN: 'some-gh-token',
        USER: 'dev',
      }),
    ).toBe(false);
  });
});

describe('evaluatePrExitCode', () => {
  function makeFinding(overrides: Partial<FindingRecord>): FindingRecord {
    return {
      id: 'f-1',
      roomId: 'room-1',
      messageId: 'm-1',
      roundId: 1,
      phase: 'r1',
      agentId: 'claude',
      canonicalId: 'can-1',
      severity: 'medium',
      file: 'src/main.ts',
      line: 10,
      summary: 'Potential edge case',
      evidence: 'Line 10 does not check for null',
      agreesWith: ['codex'],
      dissentsFrom: [],
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it('returns 0 when findings are clean or medium/low severity without dissent', () => {
    expect(evaluatePrExitCode([])).toBe(0);
    expect(evaluatePrExitCode([makeFinding({ severity: 'medium' })])).toBe(0);
    expect(evaluatePrExitCode([makeFinding({ severity: 'low' })])).toBe(0);
    expect(evaluatePrExitCode([makeFinding({ severity: 'info' })])).toBe(0);
  });

  it('returns 2 when a critical finding is present', () => {
    const findings = [makeFinding({ severity: 'critical' })];
    expect(evaluatePrExitCode(findings)).toBe(2);
  });

  it('returns 2 when a high finding is present', () => {
    const findings = [makeFinding({ severity: 'high' })];
    expect(evaluatePrExitCode(findings)).toBe(2);
  });

  it('returns 2 when any finding has active dissents', () => {
    const findings = [makeFinding({ severity: 'low', dissentsFrom: ['codex'] })];
    expect(evaluatePrExitCode(findings)).toBe(2);
  });
});

describe('CHAYXONA_PR_MARKER', () => {
  it('is the standard hidden HTML marker', () => {
    expect(CHAYXONA_PR_MARKER).toBe('<!-- chayxona-pr-review -->');
  });
});
