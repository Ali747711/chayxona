import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CheckRecord } from '../domain/types.js';
import { SecretRedactor } from '../security/redactor.js';

export interface CheckCommandSpec {
  command: string;
  args: string[];
}

const DEFAULT_ALLOWLIST = new Set([
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npx vitest run',
  'pnpm test',
  'yarn test',
  'pytest',
  'go test ./...',
  'cargo test',
]);

export function parseAndValidateCheckCommand(
  rawCommand: string,
  extraAllowlist: readonly string[] = [],
): CheckCommandSpec {
  const normalized = rawCommand.trim().replace(/\s+/g, ' ');
  const allowed = new Set([...DEFAULT_ALLOWLIST, ...extraAllowlist.map((c) => c.trim().replace(/\s+/g, ' '))]);
  if (!allowed.has(normalized)) {
    throw new Error(
      `Check command "${normalized}" is not in the explicit allowlist. Refusing to execute untrusted command.`,
    );
  }
  const parts = normalized.split(' ');
  return { command: parts[0], args: parts.slice(1) };
}

export function runAllowlistedCheck(opts: {
  revisionId: string;
  worktreePath: string;
  rawCommand: string;
  extraAllowlist?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  redactor?: SecretRedactor;
}): Promise<CheckRecord> {
  const spec = parseAndValidateCheckCommand(opts.rawCommand, opts.extraAllowlist);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 16 * 1024;
  const redactor = opts.redactor ?? new SecretRedactor();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: opts.worktreePath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;

    const append = (chunk: string): void => {
      if (Buffer.byteLength(output, 'utf8') < maxOutputBytes) {
        output += chunk;
        if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) {
          output = output.slice(0, maxOutputBytes) + '\n[check output truncated]';
        }
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    timer.unref();

    const finish = (code: number): void => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const excerpt = redactor.redact(timedOut ? `${output}\n[timed out after ${timeoutMs}ms]` : output).trim();
      resolve({
        id: `chk-${randomUUID().slice(0, 8)}`,
        revisionId: opts.revisionId,
        command: opts.rawCommand.trim(),
        exitCode: timedOut ? 124 : code,
        durationMs,
        outputExcerpt: excerpt,
        createdAt: Date.now(),
      });
    };

    child.on('error', (err) => {
      append(`\n${err.message}`);
      finish(1);
    });
    child.on('close', (code) => {
      finish(code ?? 1);
    });
  });
}
