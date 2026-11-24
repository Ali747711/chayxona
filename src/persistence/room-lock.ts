import fs from 'node:fs';
import path from 'node:path';

export class RoomLockError extends Error {
  constructor(
    public readonly roomId: string,
    public readonly ownerPid: number | null,
  ) {
    super(
      ownerPid
        ? `Room ${roomId} is already active in another process (PID ${ownerPid}).`
        : `Room ${roomId} is currently locked by another process.`,
    );
    this.name = 'RoomLockError';
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export class RoomLock {
  private released = false;

  private constructor(private readonly lockPath: string) {}

  static acquire(dataDir: string, roomId: string): RoomLock {
    const locksDir = path.join(dataDir, 'locks');
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(locksDir, `${roomId}.lock`);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        } finally {
          fs.closeSync(fd);
        }
        return new RoomLock(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let ownerPid: number | null = null;
        try {
          const raw = fs.readFileSync(lockPath, 'utf8');
          const parsed = JSON.parse(raw) as { pid?: number };
          if (typeof parsed.pid === 'number') ownerPid = parsed.pid;
        } catch {
          // Corrupt lockfile — treat as stale
        }
        if (ownerPid !== null && isPidAlive(ownerPid)) {
          throw new RoomLockError(roomId, ownerPid);
        }
        // Stale lock from dead process — unlink and retry once
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process may have unlinked it
        }
      }
    }

    throw new RoomLockError(roomId, null);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Already removed
    }
  }
}
