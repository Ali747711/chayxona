import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { createAdapters } from '../adapters/factory.js';
import type { AgentAdapter } from '../adapters/contract.js';
import { ALL_AGENTS, type AgentId, type RoomRecord } from '../domain/types.js';
import { inspectRepo, type AuditMode } from '../orchestrator/git-inspector.js';
import { RoomService } from '../orchestrator/room-service.js';
import { ChayxonaDB, openDatabase, resolveDataDir } from '../persistence/db.js';
import { RoomLock } from '../persistence/room-lock.js';
import { SecretRedactor } from '../security/redactor.js';
import { buildPrDebateTopic, fetchGitHubPr } from '../cli/pr-review.js';

export interface McpServerOptions {
  fake?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export const MCP_TOOLS = [
  {
    name: 'chayxona_debate',
    description:
      'Run an anti-sycophantic multi-agent cross-model debate (Blind R1 -> Cross-Exam R2) across Claude Code, Codex, and Antigravity.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The architectural decision, technical dilemma, or code design to debate.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of agents (e.g. ["claude", "codex", "agy"]). Defaults to all.',
        },
        fake: {
          type: 'boolean',
          description: 'Use deterministic fake providers for testing (0 LLM cost).',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'chayxona_audit',
    description:
      'Run an independent multi-agent read-only audit of Git diff, staged changes, or HEAD commit with consensus findings and dissent.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['diff', 'staged', 'head'],
          description: 'Audit target: working tree diff, staged diff, or HEAD commit. Defaults to diff.',
        },
        focus: {
          type: 'string',
          description: 'Optional focus area for the audit (e.g. "auth security", "data race").',
        },
        fake: {
          type: 'boolean',
          description: 'Use deterministic fake providers for testing.',
        },
      },
    },
  },
  {
    name: 'chayxona_review_pr',
    description:
      'Cross-review a GitHub Pull Request using Claude, Codex, and Antigravity, producing structured findings and dissent.',
    inputSchema: {
      type: 'object',
      properties: {
        prNumber: {
          type: 'string',
          description: 'GitHub PR number (e.g. "42"). Requires gh CLI authenticated.',
        },
        fake: {
          type: 'boolean',
          description: 'Use deterministic fake providers for testing.',
        },
      },
      required: ['prNumber'],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  opts: McpServerOptions,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const redactor = new SecretRedactor();
  const repo = inspectRepo(process.cwd());
  const useFake = opts.fake || Boolean(args.fake);

  if (name === 'chayxona_debate') {
    const topic = String(args.topic ?? '').trim();
    if (!topic) throw new Error('Parameter "topic" is required.');

    const agents: AgentId[] = Array.isArray(args.agents)
      ? (args.agents as AgentId[]).filter((a) => ALL_AGENTS.includes(a))
      : [...ALL_AGENTS];
    const finalAgents = agents.length > 0 ? agents : [...ALL_AGENTS];

    const allAdapters = createAdapters(redactor, useFake);
    const activeAdapters = new Map<AgentId, AgentAdapter>();
    for (const id of finalAgents) {
      const ad = allAdapters.get(id);
      if (ad) activeAdapters.set(id, ad);
    }

    const { db, dataDir } = openDatabase(repo.repoPath, false);
    const roomId = `mcp-deb-${randomUUID().slice(0, 8)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: finalAgents,
      solo: false,
      turnTimeoutMs: 180_000,
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);
    const service = new RoomService(room, db, activeAdapters, redactor);

    try {
      await service.runDebateOrAudit('debate', topic);
      const summary = service.buildLocalSummary();
      const exportMd = service.exportRoom('md');
      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n---\n\n${exportMd}`,
          },
        ],
      };
    } finally {
      lock.release();
      db.close();
    }
  }

  if (name === 'chayxona_audit') {
    const target = (String(args.target ?? 'diff').toLowerCase() as AuditMode) || 'diff';
    const focus = args.focus ? String(args.focus).trim() : undefined;

    const allAdapters = createAdapters(redactor, useFake);
    const { db, dataDir } = openDatabase(repo.repoPath, false);
    const roomId = `mcp-aud-${randomUUID().slice(0, 8)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: [...ALL_AGENTS],
      solo: false,
      turnTimeoutMs: 180_000,
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);
    const service = new RoomService(room, db, allAdapters, redactor);

    try {
      await service.runDebateOrAudit('audit', focus ?? '', target);
      const summary = service.buildLocalSummary();
      const exportMd = service.exportRoom('md');
      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n---\n\n${exportMd}`,
          },
        ],
      };
    } finally {
      lock.release();
      db.close();
    }
  }

  if (name === 'chayxona_review_pr') {
    const prNumber = String(args.prNumber ?? '').trim();
    if (!prNumber) throw new Error('Parameter "prNumber" is required.');

    const pr = fetchGitHubPr(prNumber, repo.repoPath);
    const topic = buildPrDebateTopic(pr, redactor);
    const allAdapters = createAdapters(redactor, useFake);

    const { db, dataDir } = openDatabase(repo.repoPath, false);
    const roomId = `mcp-pr-${pr.number}-${randomUUID().slice(0, 6)}`;
    const lock = RoomLock.acquire(dataDir, roomId);
    const now = Date.now();
    const room: RoomRecord = {
      id: roomId,
      repoPath: repo.repoPath,
      baseSha: repo.baseSha,
      status: 'active',
      maxTurns: 24,
      agents: [...ALL_AGENTS],
      solo: false,
      turnTimeoutMs: 180_000,
      maxConcurrency: 3,
      createdAt: now,
      updatedAt: now,
    };
    db.createRoom(room);
    const service = new RoomService(room, db, allAdapters, redactor);

    try {
      await service.runDebateOrAudit('debate', topic);
      const card = service.exportRoom('pr');
      return {
        content: [
          {
            type: 'text',
            text: card,
          },
        ],
      };
    } finally {
      lock.release();
      db.close();
    }
  }

  throw new Error(`Unknown tool "${name}".`);
}

export function createMcpServer(opts: McpServerOptions = {}): {
  processLine: (line: string) => Promise<string | null>;
  start: () => void;
} {
  const inStream = opts.stdin ?? process.stdin;
  const outStream = opts.stdout ?? process.stdout;
  const errStream = opts.stderr ?? process.stderr;

  const processLine = async (line: string): Promise<string | null> => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let req: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(trimmed);
    } catch (err) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }

    const id = req.id ?? null;

    if (req.method === 'initialize') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'chayxona',
            version: '0.5.0',
          },
        },
      });
    }

    if (req.method === 'notifications/initialized') {
      return null;
    }

    if (req.method === 'ping') {
      return JSON.stringify({ jsonrpc: '2.0', id, result: {} });
    }

    if (req.method === 'tools/list') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      });
    }

    if (req.method === 'tools/call') {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await handleToolCall(name, args, opts);
        return JSON.stringify({ jsonrpc: '2.0', id, result });
      } catch (err) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        });
      }
    }

    if (id != null) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method "${req.method}" not found.` },
      });
    }

    return null;
  };

  const start = (): void => {
    const rl = readline.createInterface({ input: inStream, terminal: false });
    rl.on('line', async (line) => {
      try {
        const res = await processLine(line);
        if (res) {
          outStream.write(`${res}\n`);
        }
      } catch (err) {
        errStream.write(`MCP server error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
  };

  return { processLine, start };
}
