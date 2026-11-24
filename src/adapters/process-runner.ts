import { spawn, type ChildProcess } from 'node:child_process';
import type { AdapterErrorCode } from '../domain/types.js';
import { SecretRedactor } from '../security/redactor.js';

/**
 * Shared POSIX process runner for all CLI adapters.
 *
 * Lifecycle:
 *   spawn(detached:true, shell:false)
 *     ├── write prompt to stdin (optional) & end()
 *     ├── stdout -> line-buffered UTF-8/CRLF framing (max 64KB/line) -> callback
 *     ├── stderr -> capped 64KB diagnostic buffer (redacted)
 *     ├── AbortSignal / timeout -> SIGTERM(-pid) -> 500ms grace -> SIGKILL(-pid)
 *     └── process 'exit' fallback -> synchronous SIGKILL(-pid) for all active PIDs
 */

const activePids = new Set<number>();
let exitHookRegistered = false;

function registerSyncExitReaper(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const pid of activePids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone
        }
      }
    }
    activePids.clear();
  });
}

export function killProcessGroupGracefully(pid: number, graceMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const send = (sig: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        try {
          process.kill(pid, sig);
          return true;
        } catch {
          return false;
        }
      }
    };

    if (!send('SIGTERM')) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      send('SIGKILL');
      resolve();
    }, graceMs);
    timer.unref();
  });
}

export interface RunSubprocessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdinText?: string;
  timeoutMs: number;
  signal: AbortSignal;
  redactor: SecretRedactor;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  graceMs?: number;
  onLine: (line: string, truncated: boolean) => void;
}

export interface RunSubprocessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  errorCode: AdapterErrorCode | null;
}

export function classifyStderrError(stderr: string): AdapterErrorCode | null {
  const lower = stderr.toLowerCase();
  if (/unauthenticated|not logged in|auth_required|login required|api key|401/.test(lower)) {
    return 'auth_required';
  }
  if (/rate limit|quota|429|out_of_credits|usage limit/.test(lower)) {
    return 'quota';
  }
  if (/permission denied|eacces|operation not permitted/.test(lower)) {
    return 'permission_denied';
  }
  return null;
}

export function runSubprocessLines(opts: RunSubprocessOptions): Promise<RunSubprocessResult> {
  registerSyncExitReaper();

  const maxLineBytes = opts.maxLineBytes ?? 64 * 1024;
  const maxStderrBytes = opts.maxStderrBytes ?? 64 * 1024;
  const graceMs = opts.graceMs ?? 500;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stderr: opts.redactor.redact(err instanceof Error ? err.message : String(err)),
        timedOut: false,
        cancelled: false,
        errorCode: 'process_exit',
      });
      return;
    }

    const pid = child.pid;
    if (pid) activePids.add(pid);

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const triggerKill = (): void => {
      if (pid) {
        void killProcessGroupGracefully(pid, graceMs);
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    const onAbort = (): void => {
      cancelled = true;
      triggerKill();
    };

    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      triggerKill();
    }, opts.timeoutMs);
    timeoutHandle.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      opts.signal.removeEventListener('abort', onAbort);
      if (pid) activePids.delete(pid);

      if (stdoutBuf.length > 0) {
        const cleaned = stdoutBuf.replace(/\r$/, '');
        if (cleaned.length > 0) {
          opts.onLine(cleaned, Buffer.byteLength(cleaned, 'utf8') > maxLineBytes);
        }
        stdoutBuf = '';
      }

      const redactedStderr = opts.redactor.redact(stderrBuf);
      let errorCode: AdapterErrorCode | null = null;
      if (cancelled) errorCode = 'cancelled';
      else if (timedOut) errorCode = 'timeout';
      else if (exitCode !== 0) {
        errorCode = classifyStderrError(redactedStderr) ?? 'process_exit';
      }

      resolve({
        exitCode,
        signal,
        stderr: redactedStderr,
        timedOut,
        cancelled,
        errorCode,
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nlIndex = stdoutBuf.indexOf('\n');
      while (nlIndex !== -1) {
        const rawLine = stdoutBuf.slice(0, nlIndex).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nlIndex + 1);
        if (rawLine.length > 0) {
          const byteLen = Buffer.byteLength(rawLine, 'utf8');
          if (byteLen > maxLineBytes) {
            opts.onLine(rawLine.slice(0, maxLineBytes), true);
          } else {
            opts.onLine(rawLine, false);
          }
        }
        nlIndex = stdoutBuf.indexOf('\n');
      }
      // Guard against unbounded single line without newline
      if (Buffer.byteLength(stdoutBuf, 'utf8') > maxLineBytes * 2) {
        opts.onLine(stdoutBuf.slice(0, maxLineBytes), true);
        stdoutBuf = '';
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderrBuf, 'utf8') < maxStderrBytes) {
        stderrBuf += chunk;
        if (Buffer.byteLength(stderrBuf, 'utf8') > maxStderrBytes) {
          stderrBuf = stderrBuf.slice(0, maxStderrBytes) + '\n[stderr truncated]';
        }
      }
    });

    child.on('error', (err) => {
      stderrBuf += `\n${err.message}`;
      finish(1, null);
    });

    child.on('close', (code, sig) => {
      finish(code, sig);
    });

    if (opts.stdinText !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // Child may exit before consuming stdin
      });
      child.stdin.end(opts.stdinText, 'utf8');
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}
