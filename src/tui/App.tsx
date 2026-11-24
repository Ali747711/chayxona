import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentId, FindingRecord, MessageRecord, RoundRecord } from '../domain/types.js';
import { filterDiffFiles, formatDiffOverview, parseGitDiff } from '../orchestrator/diff-parser.js';
import type { RoomService, RoomStatusEvent } from '../orchestrator/room-service.js';
import type { TaskService } from '../orchestrator/task-service.js';
import type { AuditMode } from '../orchestrator/git-inspector.js';
import { isPathInside } from '../persistence/db.js';
import { FindingsPanel } from './FindingsPanel.js';
import { WelcomeCard } from './WelcomeCard.js';
import { getInputSuggestions, parseUserInput } from './commands.js';
import { MarkdownText } from './markdown.js';
import { createTheme } from './theme.js';

export interface StaticEntry {
  key: string;
  sender: string;
  meta: string;
  body: string;
  isDiff?: boolean;
}

export interface AppProps {
  service: RoomService;
  taskService?: TaskService;
  dataDir: string;
  initialMessages: MessageRecord[];
  initialFindings: FindingRecord[];
  dirtyRepoWarning?: boolean;
  allowInRepoExport?: boolean;
  onExitCleanup: () => void;
}

type AgentLiveState = {
  status: 'idle' | 'running' | 'streaming' | 'done' | 'error' | 'cancelled';
  detail: string;
  startedAt?: number;
  elapsedSec?: string;
};

const HELP_TEXT = [
  'Commands:',
  '  /debate <topic>          Blind Round 1 -> Cross-Exam Round 2 debate',
  '  /audit [diff|staged|head] Independent read-only audit',
  '  /task [--auto-plan] <m>  Plan -> approve -> isolated worktree write -> review -> /apply',
  '  /approve [id]            Approve plan or final verification (defaults to active task)',
  '  /reject [reason]         Revise plan or cancel active task and clean up worktree',
  '  /apply [revision-id]     Apply approved worktree patch cleanly to main repository',
  '  /diff [file|number]      Interactive diff browser (overview or file hunks)',
  '  /warm [clear]            Inspect or clear active warm provider sessions',
  '  /checks                  Inspect allowlisted check runs for active task',
  '  /agents                  List active agents, roles, and current status',
  '  /role <agent> <lens>     Set lens (architect|security|performance|skeptic|reviewer|implementer)',
  '  @claude|@codex|@agy <m>  Targeted single-agent turn (or steer FAILED tasks)',
  '  @all <msg> or plain text Broadcast freeform turn (or R2 steering note during Blind R1)',
  '  /summary                 Deterministic local summary of findings & dissent',
  '  /findings (or Tab)       Toggle Findings & Dissent panel',
  '  /unseal (or Ctrl+U)      Unseal Blind R1 past straggler once >= 2 takes finish',
  '  /budget +<n>             Extend room turn budget',
  '  /pause | /continue       Pause before next round / resume scheduling',
  '  /recover retry|unseal|r2 Recover an interrupted round after resume',
  '  /stop [agent|all]        Cancel active turn(s)',
  '  /export [md|jsonl|pr|html] [path] Export redacted transcript, PR card, or HTML report',
  '  /help | /quit            Show help / exit cleanly',
].join('\n');

export const App: React.FC<AppProps> = ({
  service,
  taskService,
  dataDir,
  initialMessages,
  initialFindings,
  dirtyRepoWarning,
  allowInRepoExport,
  onExitCleanup,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 100;
  const rows = stdout?.rows ?? 30;
  const isNarrow = cols < 80;
  const isShort = rows < 24;
  const theme = useMemo(() => createTheme(), []);

  const [staticItems, setStaticItems] = useState<StaticEntry[]>(() => {
    const intro: StaticEntry[] = [];
    const recovery = service.inspectRecoveryState();
    if (recovery?.kind === 'incomplete_blind_r1') {
      intro.push({
        key: 'recovery-banner',
        sender: 'RECOVERY',
        meta: `R${recovery.roundId} INTERRUPTED`,
        body: `Blind Round 1 was interrupted (completed: ${recovery.completedAgents.join(', ') || 'none'}; interrupted: ${recovery.interruptedAgents.join(', ')}).\nCompleted takes remain sealed. Run \`/recover retry\` to retry interrupted agents or \`/recover unseal\` to reveal partial takes.`,
      });
    } else if (recovery?.kind === 'pending_r2' || recovery?.kind === 'incomplete_r2') {
      const isInterruptedR2 = recovery.kind === 'incomplete_r2';
      intro.push({
        key: 'recovery-banner',
        sender: 'RECOVERY',
        meta: `R${recovery.roundId} ${isInterruptedR2 ? 'INTERRUPTED R2' : 'PENDING R2'}`,
        body: isInterruptedR2
          ? `Cross-Exam Round 2 was interrupted before completion. Run \`/recover r2\` to resume Cross-Exam Round 2 with ${recovery.completedAgents.join(', ')}.`
          : `Round 1 was revealed before exit. Run \`/recover r2\` to run Cross-Exam Round 2 with ${recovery.completedAgents.join(', ')}.`,
      });
    }
    for (const m of initialMessages) {
      intro.push({
        key: m.id,
        sender: m.sender.toUpperCase(),
        meta: `R${m.roundId}·${m.roundPhase}`,
        body: m.body,
      });
    }
    return intro;
  });

  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showFindings, setShowFindings] = useState(false);
  const [findings, setFindings] = useState<FindingRecord[]>(initialFindings);
  const [round, setRound] = useState<RoundRecord | null>(service.getActiveRound());
  const [notice, setNotice] = useState<{ type: RoomStatusEvent['type']; text: string } | null>(null);
  const [queuedSteeringCount, setQueuedSteeringCount] = useState(0);
  const [agentStates, setAgentStates] = useState<Record<string, AgentLiveState>>(() => {
    const init: Record<string, AgentLiveState> = {};
    for (const a of service.room.agents) {
      init[a] = { status: 'idle', detail: '' };
    }
    return init;
  });
  const [livePreview, setLivePreview] = useState<Record<string, string>>({});
  const previewBufRef = useRef<Record<string, string>>({});
  const maxScrollRef = useRef(0);
  const previewDirtyRef = useRef(false);
  const seqRef = useRef(0);

  const pushSystemItem = (body: string, label = 'SYSTEM', isDiff = false): void => {
    seqRef.current += 1;
    setScrollOffset(0);
    setStaticItems((prev) => [
      ...prev,
      { key: `sys-${Date.now()}-${seqRef.current}`, sender: label, meta: '', body, isDiff },
    ]);
  };

  // Coalesce streaming text deltas at ~10fps (100ms), ONLY re-rendering when dirty
  useEffect(() => {
    const timer = setInterval(() => {
      if (previewDirtyRef.current) {
        previewDirtyRef.current = false;
        setLivePreview({ ...previewBufRef.current });
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Update live per-agent elapsed timers every 500ms only while at least one agent is active
  const [clockTick, setClockTick] = useState(0);
  const anyActive = Object.values(agentStates).some((s) => s.status === 'running' || s.status === 'streaming');
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setClockTick((t) => t + 1), 500);
    return () => clearInterval(timer);
  }, [anyActive]);

  useEffect(() => {
    const onMessage = (msg: MessageRecord): void => {
      setScrollOffset(0);
      setStaticItems((prev) => [
        ...prev,
        {
          key: msg.id,
          sender: msg.sender.toUpperCase(),
          meta: `R${msg.roundId}·${msg.roundPhase}`,
          body: msg.body,
        },
      ]);
      if (msg.sender !== 'human' && msg.sender !== 'system') {
        delete previewBufRef.current[msg.sender];
        setLivePreview({ ...previewBufRef.current });
      }
    };

    const onRound = (r: RoundRecord): void => {
      setRound({ ...r });
      if (r.phase === 'blind_r1') {
        setQueuedSteeringCount(0);
      }
    };

    const onFindings = (list: FindingRecord[]): void => {
      setFindings(list);
    };

    const onNotice = (n: RoomStatusEvent): void => {
      setNotice(n);
      if (n.type === 'error' || n.type === 'warning') {
        pushSystemItem(n.text, n.type.toUpperCase());
      }
    };

    const onAgentEvent = (ev: AgentEvent): void => {
      const a = ev.agentId;
      if (ev.type === 'turn.started') {
        previewBufRef.current[a] = '';
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'running', detail: 'thinking...', startedAt: Date.now() } }));
      } else if (ev.type === 'tool.started') {
        setAgentStates((prev) => ({
          ...prev,
          [a]: { ...prev[a], status: 'running', detail: `tool:${ev.toolName}` },
        }));
      } else if (ev.type === 'text.delta') {
        previewBufRef.current[a] = ((previewBufRef.current[a] ?? '') + ev.delta).slice(-400);
        previewDirtyRef.current = true;
        setAgentStates((prev) => ({
          ...prev,
          [a]: { ...prev[a], status: 'streaming', detail: 'streaming...' },
        }));
      } else if (ev.type === 'turn.completed') {
        delete previewBufRef.current[a];
        setLivePreview({ ...previewBufRef.current });
        setAgentStates((prev) => {
          const startedAt = prev[a]?.startedAt;
          const elapsedSec = startedAt ? `${((Date.now() - startedAt) / 1000).toFixed(1)}s` : undefined;
          return { ...prev, [a]: { status: 'done', detail: 'done', elapsedSec } };
        });
      } else if (ev.type === 'turn.cancelled') {
        delete previewBufRef.current[a];
        setLivePreview({ ...previewBufRef.current });
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'cancelled', detail: 'stopped' } }));
      } else if (ev.type === 'turn.failed') {
        delete previewBufRef.current[a];
        setLivePreview({ ...previewBufRef.current });
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'error', detail: ev.errorCode } }));
      }
    };

    service.on('messageCommitted', onMessage);
    service.on('roundUpdated', onRound);
    service.on('findingsUpdated', onFindings);
    service.on('notice', onNotice);
    service.on('agentEvent', onAgentEvent);

    return () => {
      service.off('messageCommitted', onMessage);
      service.off('roundUpdated', onRound);
      service.off('findingsUpdated', onFindings);
      service.off('notice', onNotice);
      service.off('agentEvent', onAgentEvent);
    };
  }, [service]);

  const suggestions = useMemo(
    () => getInputSuggestions(input, service.room.agents),
    [input, service.room.agents],
  );

  useInput(
    (_ch, key) => {
      if (key.tab && !showFindings) {
        if (suggestions.length > 0) {
          setInput(suggestions[0]);
          setHistoryIdx(null);
        } else {
          setShowFindings(true);
        }
        return;
      }
      if (key.upArrow && !showFindings && inputHistory.length > 0) {
        const nextIdx = historyIdx === null ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setInput(inputHistory[nextIdx] ?? '');
        return;
      }
      if (key.downArrow && !showFindings && historyIdx !== null) {
        if (historyIdx >= inputHistory.length - 1) {
          setHistoryIdx(null);
          setInput('');
        } else {
          const nextIdx = historyIdx + 1;
          setHistoryIdx(nextIdx);
          setInput(inputHistory[nextIdx] ?? '');
        }
        return;
      }
      if (key.pageUp && !showFindings) {
        setScrollOffset((prev) => Math.min(maxScrollRef.current, prev + 6));
        return;
      }
      if (key.pageDown && !showFindings) {
        setScrollOffset((prev) => Math.max(0, prev - 6));
        return;
      }
      if (key.ctrl && _ch === 'u') {
        service.unsealStraggler();
        return;
      }
      if (key.ctrl && _ch === 'c') {
        if (service.isRunning() || Boolean(taskService?.isRunning())) {
          service.stop('all');
          taskService?.stop();
          setNotice({
            type: 'warning',
            text: 'Stopping active turns and tasks... Press Ctrl+C again to exit immediately.',
          });
        } else {
          onExitCleanup();
          exit();
        }
      }
    },
    { isActive: !showFindings },
  );

  const handleSubmit = (raw: string): void => {
    setInput('');
    setHistoryIdx(null);
    const cmd = parseUserInput(raw);
    if (cmd.kind === 'empty') return;
    const trimmedForHistory = raw.trim();
    setInputHistory((prev) => (prev[prev.length - 1] === trimmedForHistory ? prev : [...prev.slice(-49), trimmedForHistory]));

    if (cmd.kind === 'quit') {
      service.stop('all');
      taskService?.stop();
      onExitCleanup();
      exit();
      return;
    }
    if (cmd.kind === 'help') {
      pushSystemItem(HELP_TEXT, 'HELP');
      return;
    }
    if (cmd.kind === 'agents') {
      const lines = service.room.agents.map((a) => {
        const st = agentStates[a] ?? { status: 'idle', detail: '' };
        return `  - @${a} [role: ${service.getRole(a)}] (${st.detail || st.status})`;
      });
      pushSystemItem(
        `Active agents in room ${service.room.id}:\n${lines.join('\n')}\nUse \`/role <agent> <lens>\` to switch lenses, or \`@claude|@codex|@agy <msg>\`.`,
        'AGENTS',
      );
      return;
    }
    if (cmd.kind === 'role') {
      if (cmd.invalid || !cmd.agent || !cmd.role) {
        setNotice({ type: 'warning', text: cmd.invalid ?? 'Usage: /role <agent> <role>' });
        return;
      }
      service.setRole(cmd.agent, cmd.role);
      return;
    }
    if (cmd.kind === 'findings') {
      setShowFindings((v) => !v);
      return;
    }
    if (cmd.kind === 'summary') {
      pushSystemItem(service.buildLocalSummary(), 'SUMMARY');
      return;
    }
    if (cmd.kind === 'diff') {
      const rev = taskService?.getActiveRevision();
      let rawPatch = rev?.diffPatch.trim() ?? '';
      let sourceLabel = rev ? `TASK ${rev.id}` : '';

      if (!rawPatch) {
        try {
          rawPatch = execFileSync('git', ['diff', 'HEAD'], {
            cwd: service.room.repoPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          sourceLabel = 'REPO WORKING TREE';
        } catch {
          // ignore
        }
      }

      if (!rawPatch) {
        pushSystemItem('No changes detected (clean diff).', 'DIFF');
        return;
      }

      const parsed = parseGitDiff(rawPatch);
      if (cmd.file) {
        const filtered = filterDiffFiles(parsed, cmd.file);
        if (filtered.length === 0) {
          setNotice({
            type: 'warning',
            text: `No modified file matches "${cmd.file}". Run /diff to view all changed files.`,
          });
          return;
        }
        for (const f of filtered) {
          pushSystemItem(f.raw.trim(), `DIFF: ${f.file} (${sourceLabel})`, true);
        }
        return;
      }

      const overview = formatDiffOverview(parsed);
      if (parsed.files.length <= 2) {
        const full = `${overview}\n\n${rawPatch.slice(0, 8000)}`;
        pushSystemItem(full, `DIFF (${sourceLabel})`, true);
      } else {
        const preview = `${overview}\n\n---\nShowing file 1 (${parsed.files[0].file}):\n${parsed.files[0].raw.slice(0, 4000)}`;
        pushSystemItem(preview, `DIFF (${sourceLabel})`, true);
      }
      return;
    }
    if (cmd.kind === 'warm') {
      if (cmd.action === 'clear') {
        service.clearWarmSessions();
        setNotice({ type: 'status', text: 'Warm agent sessions cleared.' });
        return;
      }
      const sessions = service.getWarmSessions();
      if (sessions.length === 0) {
        pushSystemItem(
          'No warm provider sessions active yet. Run a debate or task turn to warm sessions.',
          'WARM',
        );
        return;
      }
      const lines = ['Warm Provider Sessions (Persistent Transports):'];
      for (const s of sessions) {
        lines.push(`  - [${s.agentId.toUpperCase()}]: session=${s.sessionId} (turns=${s.turnCount})`);
      }
      lines.push('\nRun `/warm clear` to reset all warm sessions.');
      pushSystemItem(lines.join('\n'), 'WARM');
      return;
    }
    if (cmd.kind === 'checks') {
      const checks = taskService?.getActiveChecks() ?? [];
      if (checks.length === 0) {
        setNotice({ type: 'warning', text: 'No check runs recorded for the active task revision.' });
        return;
      }
      const lines = checks.map(
        (c) =>
          `${c.exitCode === 0 ? '[PASS]' : `[FAIL exit=${c.exitCode}]`} \`${c.command}\` (${c.durationMs}ms)\n${c.outputExcerpt.slice(0, 600)}`,
      );
      pushSystemItem(lines.join('\n\n'), 'CHECKS');
      return;
    }
    if (cmd.kind === 'pause') {
      service.pause();
      return;
    }
    if (cmd.kind === 'continue') {
      void service.continueScheduling().catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }
    if (cmd.kind === 'unseal') {
      service.unsealStraggler();
      return;
    }
    if (cmd.kind === 'recover') {
      if (cmd.sub === 'retry') {
        void service.recoverRetryInterrupted().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else if (cmd.sub === 'unseal') {
        void service.recoverUnsealAndContinue().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else if (cmd.sub === 'r2') {
        void service.recoverResumePendingR2().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else {
        setNotice({ type: 'warning', text: 'Usage: /recover retry | /recover unseal | /recover r2' });
      }
      return;
    }
    if (cmd.kind === 'stop') {
      service.stop(cmd.target);
      if (cmd.target === 'all') {
        taskService?.stop();
      }
      return;
    }
    if (cmd.kind === 'budget') {
      service.extendBudget(cmd.delta);
      return;
    }
    if (cmd.kind === 'export') {
      const ext = cmd.format === 'jsonl' ? 'jsonl' : cmd.format === 'html' ? 'html' : 'md';
      const defaultPath = path.join(dataDir, 'exports', `${service.room.id}${cmd.format === 'pr' ? '-pr' : ''}.${ext}`);
      const targetPath = cmd.targetPath ? path.resolve(cmd.targetPath) : defaultPath;
      if (!allowInRepoExport && isPathInside(targetPath, service.room.repoPath)) {
        pushSystemItem(
          `Refused to export inside target repo (${targetPath}). Choose a path outside the repo or restart with --allow-in-repo.`,
          'ERROR',
        );
        return;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(targetPath, service.exportRoom(cmd.format), 'utf8');
      pushSystemItem(`Exported ${cmd.format} transcript to ${targetPath}`, 'EXPORT');
      return;
    }
    if (cmd.kind === 'unknown_slash') {
      setNotice({
        type: 'warning',
        text: `Unknown command "${cmd.command}". Type /help for available commands (0 turns spent).`,
      });
      return;
    }

    if (service.isRunning() && round?.phase === 'blind_r1') {
      if (cmd.kind !== 'plain') {
        setNotice({
          type: 'warning',
          text: 'Blind Round 1 is running: only plain-text R2 steering notes or /stop, /pause, /unseal are allowed.',
        });
        return;
      }
      service.queueSteeringNote(cmd.body);
      setQueuedSteeringCount((c) => c + 1);
      return;
    }

    if (service.isRunning()) {
      setNotice({ type: 'warning', text: 'Turns are still running. Wait for completion or run /stop.' });
      return;
    }

    if (cmd.kind === 'task') {
      if (!cmd.description || !taskService) {
        setNotice({ type: 'warning', text: taskService ? 'Usage: /task [--auto-plan] <description>' : 'Task service unavailable.' });
        return;
      }
      void taskService
        .startTask(cmd.description, { autoPlan: cmd.autoPlan })
        .then((res) => {
          if (res.revision?.diffPatch) {
            pushSystemItem(res.revision.diffPatch.slice(0, 6000), `DIFF ${res.revision.id}`, true);
          }
          if (res.task.state === 'AWAITING_FINAL_APPROVAL' || res.task.state === 'READY_TO_APPLY') {
            pushSystemItem(
              `Task ${res.task.id} verified and ready! Run /apply to merge to main repo or /reject to discard.`,
              `TASK ${res.task.id}`,
            );
          } else if (res.task.state === 'AWAITING_PLAN_APPROVAL') {
            pushSystemItem(
              `Plan v${res.task.planVersion} (${res.approval.id}):\n${res.task.planText ?? ''}\n\nRun /approve to start implementation or /reject <reason> to revise.`,
              `TASK ${res.task.id}`,
            );
          } else if (res.task.state === 'FAILED') {
            pushSystemItem(
              `Task ${res.task.id} failed verification/reviews. Run @${res.task.implementer} <instruction> to steer or /reject to cancel.`,
              `TASK ${res.task.id}`,
            );
          } else {
            pushSystemItem(`Task ${res.task.id} state: ${res.task.state}`, `TASK ${res.task.id}`);
          }
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (cmd.kind === 'approve') {
      if (!taskService) {
        setNotice({ type: 'warning', text: 'Task service unavailable.' });
        return;
      }
      void taskService
        .approve(cmd.id)
        .then((res) => {
          if (res.revision?.diffPatch) {
            pushSystemItem(res.revision.diffPatch.slice(0, 6000), `DIFF ${res.revision.id}`, true);
          }
          if (res.task.state === 'AWAITING_FINAL_APPROVAL' || res.task.state === 'READY_TO_APPLY') {
            pushSystemItem(
              `Task ${res.task.id} verified and ready! Run /apply to merge to main repo or /reject to discard.`,
              `TASK ${res.task.id}`,
            );
          } else if (res.task.state === 'FAILED') {
            pushSystemItem(
              `Task ${res.task.id} failed verification/reviews. Run @${res.task.implementer} <instruction> to steer or /reject to cancel.`,
              `TASK ${res.task.id}`,
            );
          } else {
            pushSystemItem(
              `Task ${res.task.id} -> ${res.task.state}${res.revision ? ` (rev ${res.revision.id})` : ''}`,
              'TASK',
            );
          }
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (cmd.kind === 'reject') {
      if (!taskService) {
        setNotice({ type: 'warning', text: 'Task service unavailable.' });
        return;
      }
      void taskService
        .reject(cmd.reason)
        .then((res) => {
          if (res.nextApproval) {
            pushSystemItem(
              `Revised Plan v${res.task.planVersion} (${res.nextApproval.id}):\n${res.task.planText ?? ''}\n\nRun /approve to continue or /reject <reason>.`,
              `TASK ${res.task.id}`,
            );
          } else {
            pushSystemItem(`Task ${res.task.id} CANCELLED. Worktree cleaned up.`, 'TASK');
          }
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (cmd.kind === 'apply') {
      if (!taskService) {
        setNotice({ type: 'warning', text: 'Task service unavailable.' });
        return;
      }
      try {
        const done = taskService.applyRevision(cmd.revisionId);
        pushSystemItem(`Applied patch cleanly to original repository. Task ${done.id} is COMPLETED.`, 'APPLY');
      } catch (err: unknown) {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      }
      return;
    }

    if (cmd.kind === 'debate') {
      if (!cmd.topic) {
        setNotice({ type: 'warning', text: 'Usage: /debate <topic>' });
        return;
      }
      void service.runDebateOrAudit('debate', cmd.topic).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    if (cmd.kind === 'audit') {
      void service.runDebateOrAudit('audit', cmd.focus, cmd.mode).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    if (cmd.kind === 'mention') {
      const latestTask = taskService?.getLatestTask();
      if (taskService && latestTask && latestTask.state === 'FAILED' && (cmd.target === latestTask.implementer || cmd.target === 'all')) {
        void taskService
          .steer(cmd.body)
          .then((res) => {
            if (res.revision?.diffPatch) {
              pushSystemItem(res.revision.diffPatch.slice(0, 6000), `DIFF ${res.revision.id}`, true);
            }
            if (res.task.state === 'AWAITING_FINAL_APPROVAL' || res.task.state === 'READY_TO_APPLY') {
              pushSystemItem(
                `Task ${res.task.id} resumed and verified! Run /apply to merge to main repo or /reject to discard.`,
                `TASK ${res.task.id}`,
              );
            } else if (res.task.state === 'FAILED') {
              pushSystemItem(
                `Task ${res.task.id} still failing checks/reviews. Run @${res.task.implementer} <msg> to steer or /reject to cancel.`,
                `TASK ${res.task.id}`,
              );
            }
          })
          .catch((err: unknown) => {
            pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
          });
        return;
      }
      const recipients: AgentId[] = cmd.target === 'all' ? [...service.room.agents] : [cmd.target];
      void service.runFreeform(recipients, cmd.body).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    void service.runFreeform([...service.room.agents], cmd.body).catch((err: unknown) => {
      pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
    });
  };

  const budget = service.getBudgetStatus();
  const activeTask = taskService?.getLatestTask();
  const hasActiveTask = Boolean(activeTask && activeTask.state !== 'COMPLETED' && activeTask.state !== 'CANCELLED');
  const isBlind = round?.phase === 'blind_r1';
  const phaseLabel = round ? round.phase.toUpperCase() : 'IDLE';
  const frameBorderColor = isBlind ? theme.borderBlind : service.isRunning() ? theme.borderActive : theme.border;
  const noticeColor =
    notice?.type === 'error' ? theme.error : notice?.type === 'warning' ? theme.warning : theme.muted;

  // Build flattened visual lines for clean full-viewport scrolling above the fixed bottom prompt dock
  const dockReserveRows = showFindings
    ? (isShort ? 11 : 14)
    : isBlind
      ? 8
      : hasActiveTask
        ? 9
        : suggestions.length > 0
          ? 7
          : 6;
  const viewportRows = Math.max(4, rows - dockReserveRows);

  type ViewportRow =
    | { key: string; kind: 'header'; sender: string; meta: string }
    | { key: string; kind: 'diff'; line: string }
    | { key: string; kind: 'md'; line: string }
    | { key: string; kind: 'spacer' };

  const allTranscriptRows = useMemo<ViewportRow[]>(() => {
    const out: ViewportRow[] = [];
    const maxLineWidth = Math.max(30, cols - 6);
    for (const item of staticItems) {
      out.push({ key: `${item.key}-h`, kind: 'header', sender: item.sender, meta: item.meta });
      const rawLines = item.body.split('\n');
      let lineIdx = 0;
      for (const rawLine of rawLines) {
        if (rawLine.length <= maxLineWidth) {
          out.push({
            key: `${item.key}-l-${lineIdx++}`,
            kind: item.isDiff ? 'diff' : 'md',
            line: rawLine,
          });
        } else {
          for (let pos = 0; pos < rawLine.length; pos += maxLineWidth) {
            out.push({
              key: `${item.key}-l-${lineIdx++}`,
              kind: item.isDiff ? 'diff' : 'md',
              line: rawLine.slice(pos, pos + maxLineWidth),
            });
          }
        }
      }
      out.push({ key: `${item.key}-sp`, kind: 'spacer' });
    }
    return out;
  }, [staticItems, cols]);

  const maxScroll = Math.max(0, allTranscriptRows.length - viewportRows);
  maxScrollRef.current = maxScroll;
  const clampedScroll = Math.min(scrollOffset, maxScroll);
  const endIdx = allTranscriptRows.length - clampedScroll;
  const startIdx = Math.max(0, endIdx - viewportRows);
  const visibleRows = allTranscriptRows.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      {/* 1. Main viewport area: centered WelcomeCard when fresh, or scrollable transcript */}
      <Box
        flexGrow={1}
        flexDirection="column"
        justifyContent={staticItems.length === 0 ? 'center' : 'flex-end'}
        overflow="hidden"
      >
        {staticItems.length === 0 ? (
          <WelcomeCard
            roomId={service.room.id}
            repoPath={service.room.repoPath}
            agents={service.room.agents}
            getRole={(a) => service.getRole(a)}
            dirtyRepo={dirtyRepoWarning}
            cols={cols}
            theme={theme}
          />
        ) : (
          <Box flexDirection="column" paddingX={2}>
            {startIdx > 0 ? (
              <Text color={theme.muted} wrap="truncate-end">
                --- {startIdx} earlier line(s) [PgUp / PgDn to scroll] ---
              </Text>
            ) : null}
            {visibleRows.map((row) => {
              if (row.kind === 'spacer') return <Text key={row.key}> </Text>;
              if (row.kind === 'header') {
                return (
                  <Text key={row.key} wrap="truncate-end">
                    <Text bold color={theme.senderColor(row.sender)}>
                      [{row.sender}]
                    </Text>
                    {row.meta ? <Text color={theme.muted}> ({row.meta})</Text> : null}
                  </Text>
                );
              }
              if (row.kind === 'diff') {
                return (
                  <Text key={row.key} color={theme.diffLineColor(row.line)} wrap="truncate-end">
                    {'  '}
                    {row.line}
                  </Text>
                );
              }
              return (
                <Box key={row.key} paddingLeft={2}>
                  <MarkdownText text={row.line} theme={theme} />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* 2. Fixed bottom Codex-style prompt dock (permanently anchored at bottom of viewport) */}
      <Box flexDirection="column" flexShrink={0} marginX={1} borderStyle="single" borderColor={frameBorderColor} paddingX={1}>
        <Box justifyContent="space-between">
          {isNarrow ? (
            <Text wrap="truncate-end">
              <Text bold color={theme.brand}>CHAYXONA</Text>
              <Text bold color={theme.readOnlyBadge}> [RO]</Text>
              {hasActiveTask ? (
                <Text bold color="yellow"> [TASK:{activeTask?.state}]</Text>
              ) : null}
            </Text>
          ) : (
            <Text wrap="truncate-end">
              <Text bold color={theme.brand}>CHAYXONA</Text>
              <Text color={theme.muted}> / </Text>
              <Text bold>{path.basename(service.room.repoPath)}</Text>
              <Text color={theme.muted}> ({service.room.id}) </Text>
              <Text bold color={theme.readOnlyBadge}>[READ-ONLY]</Text>
              {hasActiveTask ? (
                <Text bold color="yellow"> [TASK: {activeTask?.state}]</Text>
              ) : null}
            </Text>
          )}
          <Text wrap="truncate-end">
            <Text bold color={isBlind ? theme.borderBlind : theme.phaseBadge}>{phaseLabel}</Text>
            <Text color={theme.muted}> | {isNarrow ? '' : 'Turns '}{budget.used}/{budget.max}</Text>
          </Text>
        </Box>

        <Box gap={isNarrow ? 1 : 2}>
          {service.room.agents.map((a) => {
            const st = agentStates[a] ?? { status: 'idle', detail: '' };
            const { glyph, color: glyphColor } = theme.statusGlyph(st.status);
            const agentColor = theme.senderColor(a);
            const label = isNarrow ? (a === 'claude' ? 'CLD' : a === 'codex' ? 'CDX' : 'AGY') : a.toUpperCase();
            const liveElapsed =
              (st.status === 'running' || st.status === 'streaming') && st.startedAt && clockTick >= 0
                ? ` ${((Date.now() - st.startedAt) / 1000).toFixed(isNarrow ? 0 : 1)}s`
                : st.elapsedSec
                  ? ` ${isNarrow ? st.elapsedSec.replace(/\.\d+s$/, 's') : st.elapsedSec}`
                  : '';
            return (
              <Text key={a} wrap="truncate-end">
                <Text color={glyphColor}>{glyph} </Text>
                <Text bold color={st.status === 'idle' ? theme.muted : agentColor}>{label}</Text>
                <Text color={st.detail.startsWith('tool:') ? theme.tool : theme.muted}>
                  {' '}
                  {st.detail || st.status}
                  {liveElapsed}
                </Text>
              </Text>
            );
          })}
        </Box>

        {hasActiveTask && !showFindings && !isBlind && activeTask ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="yellow" wrap="truncate-end">
              TASK {activeTask.id} [{activeTask.state} rev {activeTask.revisionCount}/{activeTask.maxRevisions}]: {activeTask.description.slice(0, 50)}
            </Text>
            <Text color={theme.muted} wrap="truncate-end">
              {activeTask.state === 'AWAITING_PLAN_APPROVAL' && 'Plan ready: run /approve to implement or /reject <reason> to revise'}
              {activeTask.state === 'IMPLEMENTING' && `Implementer @${activeTask.implementer} writing code in isolated worktree...`}
              {activeTask.state === 'VERIFYING' && 'Running allowlisted verification checks...'}
              {activeTask.state === 'REVIEWING' && 'Peer reviewer agents inspecting git diff...'}
              {activeTask.state === 'AWAITING_FINAL_APPROVAL' && 'Task verified! Run /apply to merge or /reject to discard'}
              {activeTask.state === 'READY_TO_APPLY' && 'Ready to apply! Run /apply to merge or /reject to discard'}
              {activeTask.state === 'FAILED' && `Task failed checks/reviews. Run @${activeTask.implementer} <msg> to steer or /reject to cancel`}
            </Text>
          </Box>
        ) : null}

        {isBlind && !showFindings ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={theme.borderBlind} wrap="truncate-end">
              BLIND ROUND 1 - Takes sealed until all finish ([Ctrl+U] unseal straggler)
            </Text>
            {queuedSteeringCount > 0 ? (
              <Text color={theme.phaseBadge} wrap="truncate-end">Queued for R2: {queuedSteeringCount} steering note(s)</Text>
            ) : null}
          </Box>
        ) : null}

        {!isBlind && !showFindings && !isShort && Object.keys(livePreview).length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {Object.entries(livePreview).map(([agent, preview]) =>
              preview ? (
                <Text key={agent} wrap="truncate-end">
                  <Text bold color={theme.senderColor(agent)}>{agent.toUpperCase()}: </Text>
                  <Text color={theme.muted}>{preview.replace(/\s+/g, ' ').slice(-90)}</Text>
                </Text>
              ) : null,
            )}
          </Box>
        ) : null}

        {notice ? <Text color={noticeColor} wrap="truncate-end">[!] {notice.text}</Text> : null}

        {showFindings ? (
          <FindingsPanel
            findings={findings}
            active={showFindings}
            theme={theme}
            maxVisible={isShort ? 4 : 6}
            onClose={() => setShowFindings(false)}
            onAction={(action, finding) => {
              if (action === 'task') {
                const loc = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
                setInput(`/task Fix ${finding.canonicalId}${loc}: ${finding.summary}`);
              } else if (action === 'debate') {
                const loc = finding.file ? ` in ${finding.file}` : '';
                setInput(`/debate Address ${finding.canonicalId}${loc}: ${finding.summary}`);
              }
              setShowFindings(false);
            }}
          />
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Box flexGrow={1}>
            <Text bold color={isBlind ? theme.borderBlind : theme.prompt}>
              {isBlind ? '[R2 steer] > ' : '> '}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              focus={!showFindings}
              placeholder={isBlind ? 'Type a steering note for Round 2...' : '/debate, /audit, /task, /agents, @agent, or /help'}
            />
          </Box>
          <Text color={findings.length > 0 && !isBlind ? theme.brand : theme.muted} wrap="truncate-end">
            [Tab] {suggestions.length > 0 ? 'Complete' : `Findings(${isBlind ? 'sealed' : findings.length})`}
          </Text>
        </Box>

        {suggestions.length > 0 ? (
          <Text color={theme.tool} wrap="truncate-end">
            Suggest: {suggestions.map((s) => s.trim()).join('  ')}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};
