import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RevisionRecord } from '../domain/types.js';
import { inspectRepo } from '../orchestrator/git-inspector.js';
import { isPathInside } from '../persistence/db.js';

export interface WorktreeHandle {
  worktreePath: string;
  branchName: string;
  baseSha: string;
}

function runGitOrThrow(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verifies the original repository is a clean Git repository with a valid HEAD
 * (PRD Section 10: refuse dirty repos with remediation guidance rather than stashing).
 */
export function assertCleanGitRepo(repoPath: string): { repoPath: string; baseSha: string } {
  const info = inspectRepo(repoPath);
  if (!info.isGitRepo) {
    throw new Error('Safe write-mode (/task) requires a Git repository.');
  }
  if (info.unbornHead || !info.baseSha) {
    throw new Error('Safe write-mode requires at least one commit (valid HEAD). Commit your initial files first.');
  }
  if (info.dirty) {
    throw new Error(
      'Original repository has uncommitted changes. Commit or stash your changes before running /task so Chayxona never overwrites your work.',
    );
  }
  return { repoPath: info.repoPath, baseSha: info.baseSha };
}

/**
 * Creates a dedicated task worktree + branch under `$CHAYXONA_DATA_DIR/worktrees/<roomId>/<taskId>`
 * so the original repository stays 100% untouched during implementation and review.
 */
export function createTaskWorktree(
  dataDir: string,
  repoPath: string,
  roomId: string,
  taskId: string,
): WorktreeHandle {
  const { repoPath: canonicalRepo, baseSha } = assertCleanGitRepo(repoPath);
  const worktreesRoot = path.join(dataDir, 'worktrees', roomId);
  fs.mkdirSync(worktreesRoot, { recursive: true, mode: 0o700 });

  const worktreePath = path.join(worktreesRoot, taskId);
  const branchName = `chayxona/${roomId}/${taskId}`;

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  runGitOrThrow(canonicalRepo, ['worktree', 'add', '-b', branchName, worktreePath, baseSha]);
  return { worktreePath: fs.realpathSync(worktreePath), branchName, baseSha };
}

/**
 * Validates that no modified or untracked file in the worktree is a symlink escaping
 * the worktree boundary (PRD Section 10: reject unsafe symlinks/path escapes).
 */
export function assertNoUnsafeSymlinks(worktreePath: string): void {
  const realRoot = fs.realpathSync(worktreePath);
  const statusOut = runGitOrThrow(worktreePath, ['--no-optional-locks', 'status', '--porcelain', '-uall']);
  const lines = statusOut.split('\n').filter(Boolean);

  for (const line of lines) {
    const rel = line.slice(3).trim();
    if (!rel) continue;
    const fullPath = path.join(worktreePath, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(fullPath);
      const resolvedTarget = path.resolve(path.dirname(fullPath), target);
      if (!isPathInside(resolvedTarget, realRoot)) {
        throw new Error(`Unsafe symlink escape detected in worktree: ${rel} -> ${target}`);
      }
    }
  }
}

/**
 * Captures tracked + untracked changes inside the worktree into an immutable
 * RevisionRecord with a deterministic `diffHash`.
 */
export function captureWorktreeRevision(
  taskId: string,
  handle: WorktreeHandle,
  now = Date.now(),
): RevisionRecord {
  assertNoUnsafeSymlinks(handle.worktreePath);

  // Stage all changes inside the isolated worktree (never touches original repo)
  // so untracked files appear in a standard unified diff patch
  runGitOrThrow(handle.worktreePath, ['add', '-A']);
  const diffPatch = runGitOrThrow(handle.worktreePath, [
    '--no-optional-locks',
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    handle.baseSha,
  ]);

  const diffHash = sha256(diffPatch);
  return {
    id: `rev-${randomUUID().slice(0, 8)}`,
    taskId,
    baseSha: handle.baseSha,
    diffHash,
    diffPatch,
    worktreePath: handle.worktreePath,
    branchName: handle.branchName,
    createdAt: now,
  };
}

/**
 * Safely applies an approved revision patch to the original repository.
 * Refuses if original HEAD diverged, if original working tree is dirty, or if
 * `git apply --check` fails — leaving the original repository untouched on failure.
 */
export function applyApprovedRevision(originalRepoPath: string, revision: RevisionRecord): void {
  const { repoPath, baseSha } = assertCleanGitRepo(originalRepoPath);
  if (baseSha !== revision.baseSha) {
    throw new Error(
      `Original repository HEAD diverged (expected ${revision.baseSha.slice(0, 8)}, found ${baseSha.slice(0, 8)}). Refusing to apply patch; original repository left untouched.`,
    );
  }
  if (!revision.diffPatch.trim()) {
    throw new Error(`Revision ${revision.id} has an empty diff — nothing to apply.`);
  }

  // Preflight check before mutating original repo
  try {
    runGitOrThrow(repoPath, ['apply', '--check', '-'], revision.diffPatch);
  } catch (err) {
    throw new Error(
      `Patch preflight failed for ${revision.id}; original repository left untouched: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Apply cleanly
  runGitOrThrow(repoPath, ['apply', '-'], revision.diffPatch);
}

/**
 * Removes an app-owned worktree and its temporary branch when explicitly requested.
 */
export function cleanupTaskWorktree(dataDir: string, originalRepoPath: string, handle: WorktreeHandle): void {
  const worktreesRoot = path.join(dataDir, 'worktrees');
  if (!isPathInside(handle.worktreePath, worktreesRoot)) {
    throw new Error(`Refusing to remove path outside Chayxona worktrees directory: ${handle.worktreePath}`);
  }
  try {
    runGitOrThrow(originalRepoPath, ['worktree', 'remove', '--force', handle.worktreePath]);
  } catch {
    fs.rmSync(handle.worktreePath, { recursive: true, force: true });
    try {
      runGitOrThrow(originalRepoPath, ['worktree', 'prune']);
    } catch {
      // ignore
    }
  }
  try {
    runGitOrThrow(originalRepoPath, ['branch', '-D', handle.branchName]);
  } catch {
    // ignore if branch already removed
  }
}
