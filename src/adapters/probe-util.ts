import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveExecutable(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [command], { timeout: 3000 });
    const p = stdout.trim().split('\n')[0]?.trim();
    return p || null;
  } catch {
    return null;
  }
}

export async function runQuickProbe(
  executable: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
