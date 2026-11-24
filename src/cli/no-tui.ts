import type { AgentEvent, MessageRecord } from '../domain/types.js';
import type { AuditMode } from '../orchestrator/git-inspector.js';
import type { RoomService, RoomStatusEvent, RunCommandResult } from '../orchestrator/room-service.js';

/**
 * Non-interactive / CI / piped plain-text runner for `chayxona debate --no-tui`
 * and `chayxona audit --no-tui`.
 * Exit codes: 0 = completed cleanly, 2 = partial degraded (>=2 succeeded), 1 = fatal failure.
 */
export async function runNoTuiCommand(opts: {
  service: RoomService;
  kind: 'debate' | 'audit';
  topic: string;
  auditMode?: AuditMode;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): Promise<RunCommandResult> {
  const out = opts.stdout ?? process.stdout;
  const errOut = opts.stderr ?? process.stderr;

  out.write(
    `CHAYXONA [READ-ONLY] · Room ${opts.service.room.id} · Agents: ${opts.service.room.agents.join(', ')}\n`,
  );
  out.write('Notice: Prompts and repository context are sent to your selected external CLI vendors.\n\n');

  const onMessage = (msg: MessageRecord): void => {
    out.write(`=== ${msg.sender.toUpperCase()} (R${msg.roundId} · ${msg.roundPhase}) ===\n${msg.body}\n\n`);
  };

  const onNotice = (n: RoomStatusEvent): void => {
    const stream = n.type === 'error' ? errOut : out;
    stream.write(`[${n.type.toUpperCase()}] ${n.text}\n`);
  };

  const onEvent = (ev: AgentEvent): void => {
    if (ev.type === 'tool.started') {
      out.write(`  tool(${ev.agentId}): ${ev.toolName}\n`);
    } else if (ev.type === 'turn.failed') {
      errOut.write(`  [ERROR] ${ev.agentId} (${ev.errorCode}): ${ev.message}\n`);
    }
  };

  opts.service.on('messageCommitted', onMessage);
  opts.service.on('notice', onNotice);
  opts.service.on('agentEvent', onEvent);

  const onSigInt = (): void => {
    opts.service.stop('all');
  };
  process.once('SIGINT', onSigInt);

  try {
    const res = await opts.service.runDebateOrAudit(opts.kind, opts.topic, opts.auditMode);
    out.write(`\n${opts.service.buildLocalSummary()}\n`);
    return res;
  } finally {
    process.off('SIGINT', onSigInt);
    opts.service.off('messageCommitted', onMessage);
    opts.service.off('notice', onNotice);
    opts.service.off('agentEvent', onEvent);
  }
}
