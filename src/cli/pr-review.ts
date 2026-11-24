import { execFileSync } from 'node:child_process';
import type { SecretRedactor } from '../security/redactor.js';

export interface GitHubPrMetadata {
  number: number;
  title: string;
  body: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  diff: string;
}

export function fetchGitHubPr(prRef: string, cwd: string): GitHubPrMetadata {
  let metaRaw: string;
  try {
    metaRaw = execFileSync(
      'gh',
      ['pr', 'view', prRef, '--json', 'number,title,body,url,baseRefName,headRefName'],
      { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    throw new Error(
      `Failed to fetch PR "${prRef}" via gh CLI (ensure gh is installed and authenticated): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const parsed = JSON.parse(metaRaw) as Omit<GitHubPrMetadata, 'diff'>;
  const diff = execFileSync('gh', ['pr', 'diff', prRef], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    number: parsed.number,
    title: parsed.title ?? '',
    body: parsed.body ?? '',
    url: parsed.url ?? '',
    baseRefName: parsed.baseRefName ?? 'main',
    headRefName: parsed.headRefName ?? '',
    diff,
  };
}

export function buildPrDebateTopic(
  pr: GitHubPrMetadata,
  redactor: SecretRedactor,
  maxPatchBytes = 28 * 1024,
): string {
  const safeTitle = redactor.redact(pr.title);
  const safeBody = redactor.redact(pr.body).slice(0, 2000);
  const sections = pr.diff.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const kept: string[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const section of sections) {
    const clean = redactor.redact(section);
    const bytes = Buffer.byteLength(clean, 'utf8');
    if (usedBytes + bytes > maxPatchBytes) {
      truncated = true;
      break;
    }
    kept.push(clean);
    usedBytes += bytes;
  }

  return [
    `Review GitHub PR #${pr.number}: ${safeTitle}`,
    `Branches: ${pr.headRefName} -> ${pr.baseRefName}${pr.url ? ` (${pr.url})` : ''}`,
    safeBody ? `Description:\n${safeBody}` : '',
    'Diff:',
    '```diff',
    kept.join('\n').trim(),
    '```',
    truncated ? '[PR diff truncated at 28KB; inspect remaining files as needed]' : '',
    'Identify blocking bugs, security issues, races, and edge cases with file:line evidence.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function postPrReviewComment(prRef: string, markdownBody: string, cwd: string): void {
  execFileSync('gh', ['pr', 'comment', prRef, '--body-file', '-'], {
    cwd,
    input: markdownBody,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
