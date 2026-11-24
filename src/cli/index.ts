#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { createAdapters } from '../adapters/factory.js';
import type { AgentAdapter } from '../adapters/contract.js';
import { loadProjectConfig, writeDefaultConfig, writeDefaultWorkflow } from '../config/config.js';
import { ALL_AGENTS, type AgentId, type RoomRecord } from '../domain/types.js';
import { inspectRepo, type AuditMode } from '../orchestrator/git-inspector.js';
import { RoomService } from '../orchestrator/room-service.js';
import { TaskService } from '../orchestrator/task-service.js';
import { ChayxonaDB, isPathInside, openDatabase, resolveDataDir } from '../persistence/db.js';
import { RoomLock } from '../persistence/room-lock.js';
import { SecretRedactor } from '../security/redactor.js';
import { App } from '../tui/App.js';
import { createMcpServer } from '../mcp/server.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { runNoTuiCommand } from './no-tui.js';
import {
  buildPrDebateTopic,
  evaluatePrExitCode,
  fetchGitHubPr,
  hasAvailableVendorKeys,
  postOrUpdatePrReviewComment,
  resolvePrNumber,
} from './pr-review.js';

function parseAgentsFlag(raw?: string): AgentId[] {
  if (!raw) return [...ALL_AGENTS];
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: AgentId[] = [];
  for (const id of ids) {
    if (id === 'claude' || id === 'codex' || id === 'agy') {
      if (!valid.includes(id)) valid.push(id);
    } else {
      throw new Error(`Unknown agent "${id}". Allowed: claude, codex, agy.`);
    }
  }
  return valid;
}

function parseTimeoutMs(raw?: string): number {
  if (!raw) return 180_000;
  const m = /^(\d+)(ms|s|m)?$/i.exec(raw.trim());
  if (!m) throw new Error(`Invalid timeout "${raw}". Examples: 180s, 3m, 60000ms`);
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? 's').toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 'm') return n * 60_000;
  return n * 1000;
}

async function resolveReadyAdapters(
  requested: AgentId[],
  allAdapters: Map<AgentId, AgentAdapter>,
  solo: boolean,
): Promise<{ activeAgents: AgentId[]; activeAdapters: Map<AgentId, AgentAdapter> }> {
  const activeAgents: AgentId[] = [];
  const activeAdapters = new Map<AgentId, AgentAdapter>();

  for (const id of requested) {
    const adapter = allAdapters.get(id);
    if (!adapter) continue;
    const cap = await adapter.probe();
    if (cap.available && cap.readOnlySupported && cap.streamingSupported) {
      activeAgents.push(id);
      activeAdapters.set(id, adapter);
    }
  }

  const minRequired = solo ? 1 : 2;
  if (activeAgents.length < minRequired) {
    throw new Error(
      `Found ${activeAgents.length} ready read-only agent(s) (${activeAgents.join(', ') || 'none'}); need >= ${minRequired}. Run \`chayxona doctor\` for details.`,
    );
  }
  return { activeAgents, activeAdapters };
}

function getPackageVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    if (fs.existsSync(pkgPath)) {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof raw.version === 'string') return raw.version;
    }
  } catch {
    // fallback
  }
  return '0.5.0';
}

const program = new Command();
program
  .name('chayxona')
  .description('Local-first terminal collaboration room for Claude Code, Codex, and Google Antigravity CLIs')
  .version(getPackageVersion());

program
  .command('doctor')
  .description('Probe local CLIs, read-only profiles, and Git readiness')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const redactor = new SecretRedactor();
    const report = await runDoctor(process.cwd(), createAdapters(redactor));
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatDoctorReport(report) + '\n');
    }
  });

program
  .command('init')
  .description('Create a default .chayxona.json config file in the current repository')
  .option('--workflow', 'Also scaffold .github/workflows/chayxona-review.yml for PR reviews', false)
  .option('--action', 'Alias for --workflow', false)
  .option('--force', 'Overwrite existing files', false)
  .action((opts: { force?: boolean; workflow?: boolean; action?: boolean }) => {
    const repo = inspectRepo(process.cwd());
    const filePath = writeDefaultConfig(repo.repoPath, Boolean(opts.force));
    process.stdout.write(`Created ${filePath}\n`);
    if (opts.workflow || opts.action) {
      const workflowPath = writeDefaultWorkflow(repo.repoPath, Boolean(opts.force));
      process.stdout.write(`Created ${workflowPath}\n`);
    }
  });

program
  .command('start')
  .description('Start an interactive read-only Chayxona room in the current directory')
  .option('--agents <list>', 'Comma-separated agents (claude,codex,agy)')
  .option('--max-concurrency <n>', 'Max concurrent read-only turns')
  .option('--turn-timeout <dur>', 'Per-turn timeout (e.g. 180s, 3m)')
  .option('--max-turns <n>', 'Max turns per room')
  .option('--solo', 'Allow starting with 1 agent for diagnostics', false)
  .option('--fake', 'Use deterministic fake providers (demo / local testing)', false)
  .option('--allow-in-repo', 'Allow data/export paths inside the target repo', false)
  .action(async (opts) => {
    const redactor = new SecretRedactor();
    const repo = inspectRepo(process.cwd());
    const { config } = loadProjectConfig(repo.repoPath);
    const requested = opts.agents ? parseAgentsFlag(opts.agents) : config.agents;
    const allAdapters = createAdapters(redactor, Boolean(opts.fake));
    const { activeAgents, activeAdapters } = await resolveReadyAdapters(requested, allAdapters, Boolean(opts.solo));

    const { db, dataDir } = openDatabase(repo.repoPath, Boolean(opts.allowInRepo));
    const roomId = `r-${randomUUID().slice(0, 8)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: opts.maxTurns ? Number.parseInt(String(opts.maxTurns), 10) : config.limits.maxTurns,
      agents: activeAgents,
      solo: Boolean(opts.solo),
      turnTimeoutMs: opts.turnTimeout ? parseTimeoutMs(opts.turnTimeout) : config.limits.turnTimeoutMs,
      maxConcurrency: opts.maxConcurrency
        ? Number.parseInt(String(opts.maxConcurrency), 10)
        : config.limits.maxConcurrency,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);

    const service = new RoomService(room, db, activeAdapters, redactor);
    const taskService = new TaskService(
      room,
      dataDir,
      db,
      activeAdapters,
      redactor,
      config.checks,
      {
        onStatus: (text) => service.emit('notice', { type: 'status', text }),
        onAgentEvent: (ev) => service.emit('agentEvent', ev),
      },
    );
    let cleanedUp = false;
    const isTty = Boolean(process.stdout.isTTY);
    if (isTty) {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    }
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (isTty) {
        process.stdout.write('\x1b[?1049l');
      }
      try {
        service.stop('all');
        taskService.stop();
      } catch {
        // best effort
      }
      try {
        db.releaseWriterLease(roomId);
      } catch {
        // best effort
      }
      try {
        lock.release();
      } catch {
        // best effort
      }
      try {
        db.close();
      } catch {
        // best effort
      }
    };

    const instance = render(
      React.createElement(App, {
        service,
        taskService,
        dataDir,
        initialMessages: [],
        initialFindings: [],
        dirtyRepoWarning: repo.dirty,
        allowInRepoExport: Boolean(opts.allowInRepo),
        onExitCleanup: cleanup,
      }),
    );
    await instance.waitUntilExit();
    cleanup();
  });

program
  .command('debate <topic>')
  .description('Run a non-interactive Blind R1 -> Cross-Exam R2 debate (--no-tui)')
  .option('--no-tui', 'Stream plain text to stdout and exit')
  .option('--agents <list>', 'Comma-separated agents (claude,codex,agy)')
  .option('--turn-timeout <dur>', 'Per-turn timeout (e.g. 180s)', '180s')
  .option('--solo', 'Allow 1 agent', false)
  .option('--fake', 'Use deterministic fake providers', false)
  .option('--allow-in-repo', 'Allow data dir inside target repo', false)
  .action(async (topic: string, opts) => {
    const redactor = new SecretRedactor();
    const repo = inspectRepo(process.cwd());
    const requested = parseAgentsFlag(opts.agents);
    const allAdapters = createAdapters(redactor, Boolean(opts.fake));
    const { activeAgents, activeAdapters } = await resolveReadyAdapters(requested, allAdapters, Boolean(opts.solo));

    const { db, dataDir } = openDatabase(repo.repoPath, Boolean(opts.allowInRepo));
    const roomId = `r-${randomUUID().slice(0, 8)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: activeAgents,
      solo: Boolean(opts.solo),
      turnTimeoutMs: parseTimeoutMs(opts.turnTimeout),
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);

    const service = new RoomService(room, db, activeAdapters, redactor);
    try {
      const res = await runNoTuiCommand({ service, kind: 'debate', topic });
      process.exitCode = res.exitCode;
    } finally {
      lock.release();
      db.close();
    }
  });

program
  .command('audit [target]')
  .description('Run a non-interactive read-only audit (diff | staged | head)')
  .option('--no-tui', 'Stream plain text to stdout and exit')
  .option('--agents <list>', 'Comma-separated agents (claude,codex,agy)')
  .option('--turn-timeout <dur>', 'Per-turn timeout (e.g. 180s)', '180s')
  .option('--solo', 'Allow 1 agent', false)
  .option('--fake', 'Use deterministic fake providers', false)
  .option('--allow-in-repo', 'Allow data dir inside target repo', false)
  .action(async (target: string | undefined, opts) => {
    const mode: AuditMode | undefined =
      target === 'diff' || target === 'staged' || target === 'head' ? target : undefined;
    if (target && !mode) {
      throw new Error(`Invalid audit target "${target}". Expected: diff, staged, or head.`);
    }

    const redactor = new SecretRedactor();
    const repo = inspectRepo(process.cwd());
    const requested = parseAgentsFlag(opts.agents);
    const allAdapters = createAdapters(redactor, Boolean(opts.fake));
    const { activeAgents, activeAdapters } = await resolveReadyAdapters(requested, allAdapters, Boolean(opts.solo));

    const { db, dataDir } = openDatabase(repo.repoPath, Boolean(opts.allowInRepo));
    const roomId = `r-${randomUUID().slice(0, 8)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: activeAgents,
      solo: Boolean(opts.solo),
      turnTimeoutMs: parseTimeoutMs(opts.turnTimeout),
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);

    const service = new RoomService(room, db, activeAdapters, redactor);
    try {
      const res = await runNoTuiCommand({ service, kind: 'audit', topic: '', auditMode: mode });
      process.exitCode = res.exitCode;
    } finally {
      lock.release();
      db.close();
    }
  });

program
  .command('pr [number]')
  .description('Cross-review a GitHub PR with Blind R1 -> Cross-Exam R2 via gh CLI')
  .option('--ci', 'Run in CI mode with auto-detected PR number and findings exit codes', false)
  .option('--post', 'Post the consensus Findings & Dissent card as a GitHub PR comment', false)
  .option('--agents <list>', 'Comma-separated agents (claude,codex,agy)')
  .option('--turn-timeout <dur>', 'Per-turn timeout (e.g. 180s)', '180s')
  .option('--solo', 'Allow 1 agent', false)
  .option('--fake', 'Use deterministic fake providers', false)
  .option('--allow-in-repo', 'Allow data dir inside target repo', false)
  .action(async (prNumberInput: string | undefined, opts) => {
    if (opts.ci && !opts.fake && !hasAvailableVendorKeys()) {
      process.stdout.write(
        '::warning::Chayxona review skipped: vendor API secrets are unavailable for fork PRs\n',
      );
      process.exitCode = 0;
      return;
    }

    const prNumber = resolvePrNumber(prNumberInput);
    const redactor = new SecretRedactor();
    const repo = inspectRepo(process.cwd());
    const pr = fetchGitHubPr(prNumber, repo.repoPath);
    const topic = buildPrDebateTopic(pr, redactor);

    const requested = parseAgentsFlag(opts.agents);
    const allAdapters = createAdapters(redactor, Boolean(opts.fake));
    const { activeAgents, activeAdapters } = await resolveReadyAdapters(requested, allAdapters, Boolean(opts.solo));

    const { db, dataDir } = openDatabase(repo.repoPath, Boolean(opts.allowInRepo));
    const roomId = `pr-${pr.number}-${randomUUID().slice(0, 6)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: activeAgents,
      solo: Boolean(opts.solo),
      turnTimeoutMs: parseTimeoutMs(opts.turnTimeout),
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);

    const service = new RoomService(room, db, activeAdapters, redactor);
    try {
      const res = await runNoTuiCommand({ service, kind: 'debate', topic });
      const card = service.exportRoom('pr');
      process.stdout.write(`\n${card}\n`);
      if ((opts.post || opts.ci) && res.exitCode !== 1) {
        postOrUpdatePrReviewComment(prNumber, card, repo.repoPath);
        process.stdout.write(`Posted Chayxona cross-model review comment to PR #${pr.number}.\n`);
      }
      if (opts.ci) {
        const findings = db.listVisibleFindings(roomId);
        process.exitCode = res.exitCode === 1 ? 1 : evaluatePrExitCode(findings);
      } else {
        process.exitCode = res.exitCode;
      }
    } finally {
      lock.release();
      db.close();
    }
  });

program
  .command('rooms')
  .description('List saved Chayxona rooms')
  .action(() => {
    const dataDir = resolveDataDir();
    const db = new ChayxonaDB(path.join(dataDir, 'chayxona.db'));
    try {
      const rooms = db.listRooms(30);
      if (rooms.length === 0) {
        process.stdout.write('No saved rooms yet.\n');
        return;
      }
      for (const r of rooms) {
        const turns = db.countRoomTurns(r.id);
        process.stdout.write(
          `${r.id}  turns=${turns}/${r.maxTurns}  agents=${r.agents.join(',')}  repo=${r.repoPath}\n`,
        );
      }
    } finally {
      db.close();
    }
  });

program
  .command('resume <roomId>')
  .description('Resume a saved Chayxona room without replaying turns')
  .option('--fake', 'Use deterministic fake providers', false)
  .action(async (roomId: string, opts: { fake?: boolean }) => {
    const dataDir = resolveDataDir();
    const db = new ChayxonaDB(path.join(dataDir, 'chayxona.db'));
    const room = db.getRoom(roomId);
    if (!room) {
      db.close();
      throw new Error(`Room "${roomId}" not found.`);
    }

    const lock = RoomLock.acquire(dataDir, roomId);
    const interrupted = db.markRunningTurnsInterrupted(roomId);
    const redactor = new SecretRedactor();
    const allAdapters = createAdapters(redactor, Boolean(opts.fake));
    const { activeAdapters } = await resolveReadyAdapters(room.agents, allAdapters, room.solo);

    const { config } = loadProjectConfig(room.repoPath);
    const service = new RoomService(room, db, activeAdapters, redactor);
    const taskService = new TaskService(
      room,
      dataDir,
      db,
      activeAdapters,
      redactor,
      config.checks,
      {
        onStatus: (text) => service.emit('notice', { type: 'status', text }),
        onAgentEvent: (ev) => service.emit('agentEvent', ev),
      },
    );
    const initialMessages = db.listMessages(roomId, { includeSealed: false });
    const initialFindings = db.listVisibleFindings(roomId);

    let cleanedUp = false;
    const isTty = Boolean(process.stdout.isTTY);
    if (isTty) {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    }
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (isTty) {
        process.stdout.write('\x1b[?1049l');
      }
      try {
        service.stop('all');
        taskService.stop();
      } catch {
        // best effort
      }
      try {
        db.releaseWriterLease(roomId);
      } catch {
        // best effort
      }
      try {
        lock.release();
      } catch {
        // best effort
      }
      try {
        db.close();
      } catch {
        // best effort
      }
    };

    const instance = render(
      React.createElement(App, {
        service,
        taskService,
        dataDir,
        initialMessages,
        initialFindings,
        dirtyRepoWarning: interrupted > 0,
        onExitCleanup: cleanup,
      }),
    );
    await instance.waitUntilExit();
    cleanup();
  });

program
  .command('export [roomId]')
  .description('Export a secret-redacted room transcript, GitHub PR decision card, or HTML report (default: latest)')
  .option('--format <fmt>', 'Output format (md | jsonl | pr | html)', 'md')
  .option('--out <path>', 'Write to file path instead of stdout')
  .option('--allow-in-repo', 'Allow writing export file inside the target repo', false)
  .action((roomIdArg?: string, opts?: { format?: string; out?: string; allowInRepo?: boolean }) => {
    const cwd = process.cwd();
    const { db } = openDatabase(cwd, Boolean(opts?.allowInRepo));
    try {
      let roomId = roomIdArg;
      if (!roomId || roomId === 'latest') {
        const rooms = db.listRooms(20);
        const match = rooms.find((r) => r.repoPath === cwd) ?? rooms[0];
        if (!match) throw new Error('No rooms found to export. Run `chayxona debate` or `chayxona start` first.');
        roomId = match.id;
      }
      const room = db.getRoom(roomId);
      if (!room) throw new Error(`Room "${roomId}" not found.`);
      const redactor = new SecretRedactor();
      const service = new RoomService(room, db, new Map(), redactor);
      const fmtRaw = opts?.format?.toLowerCase();
      const format: 'md' | 'jsonl' | 'pr' | 'html' =
        fmtRaw === 'jsonl' ? 'jsonl' : fmtRaw === 'pr' ? 'pr' : fmtRaw === 'html' ? 'html' : 'md';
      const content = service.exportRoom(format);
      if (opts?.out) {
        const outPath = path.resolve(opts.out);
        if (!opts?.allowInRepo && isPathInside(outPath, room.repoPath)) {
          throw new Error(`Refused to write export inside target repo (${outPath}). Re-run with --allow-in-repo to permit writing in repo.`);
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(outPath, content, 'utf8');
        process.stdout.write(`Exported room ${roomId} (${format}) to ${outPath}\n`);
      } else {
        process.stdout.write(content);
      }
    } finally {
      db.close();
    }
  });

program
  .command('mcp')
  .description('Run Chayxona as a local Model Context Protocol (MCP) server over stdio')
  .option('--fake', 'Use deterministic fake providers (0 LLM cost)', false)
  .action((opts: { fake?: boolean }) => {
    const server = createMcpServer({ fake: Boolean(opts.fake) });
    server.start();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
