import { describe, expect, it } from 'vitest';
import { buildPrDebateTopic } from '../src/cli/pr-review.js';
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
