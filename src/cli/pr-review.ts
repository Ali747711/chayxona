import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { FindingRecord } from '../domain/types.js';
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

export const CHAYXONA_PR_MARKER = '<!-- chayxona-pr-review -->';

export function hasAvailableVendorKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY,
  );
}

export function resolvePrNumber(
  prRef?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (prRef && prRef.trim().length > 0) {
    return prRef.trim();
  }

  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const raw = fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8');
      const event = JSON.parse(raw) as {
        pull_request?: { number?: number };
        issue?: { number?: number };
      };
      const num = event.pull_request?.number ?? event.issue?.number;
      if (num != null) {
        return String(num);
      }
    } catch {
      // ignore parse failure and fall through
    }
  }

  if (env.GITHUB_REF) {
    const match = env.GITHUB_REF.match(/refs\/pull\/(\d+)\//);
    if (match && match[1]) {
      return match[1];
    }
  }

  throw new Error(
    'Could not determine PR number. Pass PR number as an argument or run within a GitHub pull_request workflow.',
  );
}

export function resolveRepoSlug(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string } {
  if (env.GITHUB_REPOSITORY) {
    const parts = env.GITHUB_REPOSITORY.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  try {
    const raw = execFileSync('gh', ['repo', 'view', '--json', 'owner,name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as {
      owner?: { login?: string } | string;
      name?: string;
    };
    const owner = typeof parsed.owner === 'object' ? parsed.owner?.login : parsed.owner;
    const repo = parsed.name;
    if (owner && repo) {
      return { owner, repo };
    }
  } catch {
    // ignore and fall through
  }

  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match && match[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // ignore
  }

  throw new Error(
    'Could not resolve repository slug (owner/repo). Set GITHUB_REPOSITORY or configure git origin.',
  );
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

export function postOrUpdatePrReviewComment(
  prRef: string,
  markdownBody: string,
  cwd: string,
  repoSlug?: { owner: string; repo: string },
): void {
  const content = markdownBody.includes(CHAYXONA_PR_MARKER)
    ? markdownBody
    : `${CHAYXONA_PR_MARKER}\n\n${markdownBody}`;

  let slug = repoSlug;
  if (!slug) {
    try {
      slug = resolveRepoSlug(cwd);
    } catch {
      // ignore
    }
  }

  if (slug) {
    try {
      const prNumber = /^\d+$/.test(prRef) ? prRef : prRef.replace(/\D/g, '');
      if (prNumber) {
        const raw = execFileSync(
          'gh',
          ['api', `repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`, '--paginate'],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const comments = JSON.parse(raw) as Array<{ id: number; body?: string }>;
        const existing = comments.find((c) => c.body && c.body.includes(CHAYXONA_PR_MARKER));
        if (existing) {
          execFileSync(
            'gh',
            ['api', '--method', 'PATCH', `repos/${slug.owner}/${slug.repo}/issues/comments/${existing.id}`, '--input', '-'],
            {
              cwd,
              input: JSON.stringify({ body: content }),
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          return;
        }
      }
    } catch {
      // Fall back to standard pr comment
    }
  }

  postPrReviewComment(prRef, content, cwd);
}

export function evaluatePrExitCode(findings: FindingRecord[]): number {
  const hasBlocking = findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high' || f.dissentsFrom.length > 0,
  );
  return hasBlocking ? 2 : 0;
}
