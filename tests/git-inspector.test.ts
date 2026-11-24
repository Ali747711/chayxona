import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuditPayload, inspectRepo } from '../src/orchestrator/git-inspector.js';
import { SecretRedactor } from '../src/security/redactor.js';

describe('git-inspector', () => {
  it('handles unborn HEAD, untracked files, .env exclusion, and redaction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-git-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'app.ts'), 'export const token = "sk-proj-1234567890abcdef123456";\n');
      fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaa\n');

      const repo = inspectRepo(dir);
      expect(repo.isGitRepo).toBe(true);
      expect(repo.unbornHead).toBe(true);
      expect(repo.dirty).toBe(true);

      const redactor = new SecretRedactor({});
      expect(() => buildAuditPayload(repo, 'head', redactor)).toThrow(/unborn HEAD/i);

      const payload = buildAuditPayload(repo, 'diff', redactor);
      expect(payload.empty).toBe(false);
      expect(payload.patch).toContain('app.ts');
      expect(payload.patch).not.toContain('.env');
      expect(payload.patch).not.toContain('sk-proj-');
      expect(payload.patch).toContain('[REDACTED]');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates large diffs at file boundaries while preserving full stat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-git-trunc-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'.repeat(2000));
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n'.repeat(2000));
      const repo = inspectRepo(dir);
      const payload = buildAuditPayload(repo, 'diff', new SecretRedactor({}), 5000);
      expect(payload.truncated).toBe(true);
      expect(payload.stat).toContain('a.txt');
      expect(payload.stat).toContain('b.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
