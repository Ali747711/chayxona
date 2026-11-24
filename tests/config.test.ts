import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, DEFAULT_PROJECT_CONFIG, loadProjectConfig, writeDefaultConfig } from '../src/config/config.js';

describe('project config (.chayxona.json)', () => {
  it('returns safe defaults when no .chayxona.json exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-cfg-'));
    try {
      const { config, sourcePath } = loadProjectConfig(dir);
      expect(sourcePath).toBeNull();
      expect(config).toEqual(DEFAULT_PROJECT_CONFIG);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes default config via init and loads custom values cleanly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-cfg-'));
    try {
      const written = writeDefaultConfig(dir);
      expect(written).toBe(path.join(dir, CONFIG_FILENAME));
      expect(() => writeDefaultConfig(dir, false)).toThrow(/already exists/i);

      fs.writeFileSync(
        written,
        JSON.stringify({
          version: 1,
          agents: ['claude', 'codex'],
          limits: { maxTurns: 36, maxRevisions: 3, turnTimeoutMs: 120000, maxConcurrency: 2 },
          checks: ['npm run typecheck', 'npm test'],
        }),
      );
      const { config, sourcePath } = loadProjectConfig(dir);
      expect(sourcePath).toBe(written);
      expect(config.agents).toEqual(['claude', 'codex']);
      expect(config.limits.maxTurns).toBe(36);
      expect(config.checks).toEqual(['npm run typecheck', 'npm test']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown schema keys strictly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chayxona-cfg-bad-'));
    try {
      fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ version: 1, allowUnsafeBypass: true }));
      expect(() => loadProjectConfig(dir)).toThrow(/Invalid .chayxona.json schema/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
