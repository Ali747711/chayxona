import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SecretRedactor } from '../security/redactor.js';

export type AuditMode = 'diff' | 'staged' | 'head';

export interface RepoInspection {
  isGitRepo: boolean;
  repoPath: string;
  baseSha: string | null;
  unbornHead: boolean;
  dirty: boolean;
  statusPorcelain: string;
}

export interface AuditPayload {
  mode: AuditMode;
  stat: string;
  patch: string;
  truncated: boolean;
  disclaimer: string | null;
  empty: boolean;
}

const EXCLUDED_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
];

function isExcludedPath(relPath: string): boolean {
  return EXCLUDED_PATTERNS.some((re) => re.test(relPath));
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
    };
  }
}

export function inspectRepo(cwd: string): RepoInspection {
  const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  const top = runGit(realCwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout.trim()) {
    return {
      isGitRepo: false,
      repoPath: realCwd,
      baseSha: null,
      unbornHead: false,
      dirty: false,
      statusPorcelain: '',
    };
  }

  const repoPath = fs.realpathSync(top.stdout.trim());
  const head = runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  const unbornHead = !head.ok;
  const baseSha = head.ok ? head.stdout.trim() : null;
  const status = runGit(repoPath, ['status', '--porcelain']);
  const statusPorcelain = status.ok ? status.stdout.trimEnd() : '';

  return {
    isGitRepo: true,
    repoPath,
    baseSha,
    unbornHead,
    dirty: statusPorcelain.length > 0,
    statusPorcelain,
  };
}

export function getTreeFingerprint(repoPath: string): string {
  const status = runGit(repoPath, ['status', '--porcelain']);
  return status.ok ? status.stdout.trimEnd() : '';
}

export function buildAuditPayload(
  repo: RepoInspection,
  requestedMode: AuditMode | undefined,
  redactor: SecretRedactor,
  maxPatchBytes = 32 * 1024,
): AuditPayload {
  if (!repo.isGitRepo) {
    throw new Error('/audit requires a Git repository.');
  }

  const mode: AuditMode = requestedMode ?? (repo.dirty ? 'diff' : 'head');

  if (mode === 'head' && repo.unbornHead) {
    throw new Error('No commits yet (unborn HEAD) — run `/audit diff` or `/audit staged` instead.');
  }

  const diffBaseArgs = ['diff', '--no-ext-diff', '--no-textconv'];
  let stat = '';
  let rawPatch = '';
  let disclaimer: string | null = null;

  if (mode === 'head') {
    stat = runGit(repo.repoPath, ['show', '--stat', '--format=oneline', '--no-patch', 'HEAD']).stdout;
    rawPatch = runGit(repo.repoPath, ['show', '--no-ext-diff', '--no-textconv', '--format=', 'HEAD']).stdout;
    if (repo.dirty) {
      disclaimer = 'Evaluate ONLY the HEAD commit diff below; the live working tree also contains uncommitted edits.';
    }
  } else if (mode === 'staged') {
    stat = runGit(repo.repoPath, [...diffBaseArgs, '--cached', '--stat']).stdout;
    rawPatch = runGit(repo.repoPath, [...diffBaseArgs, '--cached']).stdout;
    disclaimer = 'Evaluate ONLY the staged diff below; live files may contain additional unstaged edits.';
  } else {
    // mode === 'diff': tracked changes + untracked text files
    if (repo.unbornHead) {
      stat = runGit(repo.repoPath, [...diffBaseArgs, '--cached', '--stat']).stdout;
      rawPatch = runGit(repo.repoPath, [...diffBaseArgs, '--cached']).stdout;
    } else {
      stat = runGit(repo.repoPath, [...diffBaseArgs, 'HEAD', '--stat']).stdout;
      rawPatch = runGit(repo.repoPath, [...diffBaseArgs, 'HEAD']).stdout;
    }

    // Append untracked text files (excluding secrets/lockfiles/binaries)
    const untracked = runGit(repo.repoPath, ['ls-files', '--others', '--exclude-standard']).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isExcludedPath(s));

    if (untracked.length > 0) {
      const untrackedStat = untracked.map((f) => ` ${f} (untracked)`).join('\n');
      stat = [stat.trimEnd(), untrackedStat].filter(Boolean).join('\n');
      for (const rel of untracked) {
        const abs = path.join(repo.repoPath, rel);
        try {
          const buf = fs.readFileSync(abs);
          // Skip binary files (NUL byte check in first 4KB)
          if (buf.subarray(0, 4096).includes(0)) continue;
          const text = buf.toString('utf8');
          rawPatch += `\ndiff --git a/${rel} b/${rel}\nnew file (untracked)\n--- /dev/null\n+++ b/${rel}\n${text}\n`;
        } catch {
          // Skip unreadable file
        }
      }
    }
  }

  // Filter out excluded file sections from diff --git blocks and truncate cleanly at file boundaries
  const sections = rawPatch.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const keptSections: string[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const section of sections) {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(section);
    const filePath = headerMatch ? headerMatch[2] : '';
    if (filePath && isExcludedPath(filePath)) continue;

    const redactedSection = redactor.redact(section);
    const sectionBytes = Buffer.byteLength(redactedSection, 'utf8');
    if (usedBytes + sectionBytes > maxPatchBytes) {
      truncated = true;
      break;
    }
    keptSections.push(redactedSection);
    usedBytes += sectionBytes;
  }

  const finalPatch = keptSections.join('\n').trim();
  const finalStat = redactor.redact(stat.trim());

  return {
    mode,
    stat: finalStat,
    patch: finalPatch,
    truncated,
    disclaimer,
    empty: finalStat.length === 0 && finalPatch.length === 0,
  };
}
