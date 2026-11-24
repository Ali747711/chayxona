import type { AgentAdapter } from '../adapters/contract.js';
import type { AgentId, ProviderCapabilities } from '../domain/types.js';
import { inspectRepo, type RepoInspection } from '../orchestrator/git-inspector.js';
import { resolveDataDir } from '../persistence/db.js';

export interface DoctorReport {
  nodeVersion: string;
  dataDir: string;
  repo: RepoInspection;
  providers: ProviderCapabilities[];
  readyAgents: AgentId[];
  collaborativeReady: boolean;
}

export async function runDoctor(
  cwd: string,
  adapters: Map<AgentId, AgentAdapter>,
): Promise<DoctorReport> {
  const repo = inspectRepo(cwd);
  const providers = await Promise.all([...adapters.values()].map((a) => a.probe()));
  const readyAgents = providers
    .filter((p) => p.available && p.readOnlySupported && p.streamingSupported)
    .map((p) => p.id);

  return {
    nodeVersion: process.version,
    dataDir: resolveDataDir(),
    repo,
    providers,
    readyAgents,
    collaborativeReady: readyAgents.length >= 2,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'Chayxona Doctor (Read-Only Room Readiness)',
    '──────────────────────────────────────────',
    `Node.js:   ${report.nodeVersion}`,
    `Data dir:  ${report.dataDir}`,
    `Repo:      ${report.repo.repoPath} (${report.repo.isGitRepo ? (report.repo.dirty ? 'git · dirty' : 'git · clean') : 'non-git · /audit disabled'})`,
    '',
    'Providers:',
  ];

  for (const p of report.providers) {
    const status = p.available && p.readOnlySupported && p.streamingSupported ? 'READY' : 'UNAVAILABLE';
    const ver = p.version ? ` (${p.version})` : '';
    const detail = p.error ?? (p.readOnlyProfile ? `profile: ${p.readOnlyProfile}` : 'ok');
    lines.push(`  [${status.padEnd(11)}] ${p.id.padEnd(7)}${ver} — ${detail}`);
  }

  lines.push('');
  lines.push(
    report.collaborativeReady
      ? `Status: READY for collaborative mode (${report.readyAgents.length} agents: ${report.readyAgents.join(', ')}).`
      : `Status: Need >= 2 ready agents for collaborative mode (found ${report.readyAgents.length}). Use --solo for diagnostics.`,
  );
  return lines.join('\n');
}
