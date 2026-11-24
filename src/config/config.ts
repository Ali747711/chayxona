import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentId } from '../domain/types.js';

const AgentIdSchema = z.enum(['claude', 'codex', 'agy']);

const ProjectConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    agents: z.array(AgentIdSchema).min(1).max(3).default(['claude', 'codex', 'agy']),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(200).default(24),
        maxRevisions: z.number().int().min(1).max(10).default(2),
        turnTimeoutMs: z.number().int().min(5000).max(900_000).default(180_000),
        maxConcurrency: z.number().int().min(1).max(3).default(3),
      })
      .strict()
      .default({}),
    checks: z.array(z.string().min(1)).max(10).default([]),
    exclude: z.array(z.string().min(1)).max(50).default(['.env*', '*.pem', '*.key']),
  })
  .strict();

export type ProjectConfig = {
  version: 1;
  agents: AgentId[];
  limits: {
    maxTurns: number;
    maxRevisions: number;
    turnTimeoutMs: number;
    maxConcurrency: number;
  };
  checks: string[];
  exclude: string[];
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = ProjectConfigSchema.parse({});

export const CONFIG_FILENAME = '.chayxona.json';

export const DEFAULT_WORKFLOW_CONTENT = `name: Chayxona PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    name: Cross-Model PR Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Run Chayxona Review
        uses: Ali747711/chayxona@main
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: \${{ secrets.OPENAI_API_KEY }}
          gemini_api_key: \${{ secrets.GEMINI_API_KEY }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
`;

export function writeDefaultWorkflow(repoPath: string, force = false): string {
  const workflowDir = path.join(repoPath, '.github', 'workflows');
  const filePath = path.join(workflowDir, 'chayxona-review.yml');
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`.github/workflows/chayxona-review.yml already exists at ${filePath}. Pass --force to overwrite.`);
  }
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(filePath, DEFAULT_WORKFLOW_CONTENT, 'utf8');
  return filePath;
}

export function loadProjectConfig(repoPath: string): { config: ProjectConfig; sourcePath: string | null } {
  const filePath = path.join(repoPath, CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) {
    return { config: { ...DEFAULT_PROJECT_CONFIG }, sourcePath: null };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const res = ProjectConfigSchema.safeParse(parsedJson);
  if (!res.success) {
    throw new Error(
      `Invalid ${CONFIG_FILENAME} schema: ${res.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
    );
  }
  return { config: res.data, sourcePath: filePath };
}

export function writeDefaultConfig(repoPath: string, force = false): string {
  const filePath = path.join(repoPath, CONFIG_FILENAME);
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`${CONFIG_FILENAME} already exists at ${filePath}. Pass --force to overwrite.`);
  }
  fs.writeFileSync(filePath, JSON.stringify(DEFAULT_PROJECT_CONFIG, null, 2) + '\n', 'utf8');
  return filePath;
}
