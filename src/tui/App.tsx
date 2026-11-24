import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentId, FindingRecord, MessageRecord, RoundRecord } from '../domain/types.js';
import type { RoomService, RoomStatusEvent } from '../orchestrator/room-service.js';
import type { TaskService } from '../orchestrator/task-service.js';
import type { AuditMode } from '../orchestrator/git-inspector.js';
import { isPathInside } from '../persistence/db.js';
import { FindingsPanel } from './FindingsPanel.js';
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
};

const HELP_TEXT = [
  'Commands:',
  '  /debate <topic>          Blind Round 1 -> Cross-Exam Round 2 debate',
  '  /audit [diff|staged|head] Independent read-only audit',
  '  /task <description>      Plan -> approve -> isolated worktree write -> review -> /apply',
  '  /approve <id> | /reject <id> <reason>  Resolve pending plan or final approval',
  '  /diff                    Show colorized diff of active task revision',
  '  /apply <revision-id>     Apply approved worktree patch to original repo',
  '  @claude|@codex|@agy <m>  Targeted single-agent turn',
  '  @all <msg> or plain text Broadcast freeform turn (or R2 steering note during Blind R1)',
  '  /summary                 Deterministic local summary of findings & dissent',
  '  /findings (or Tab)       Toggle Findings & Dissent panel',
  '  /unseal (or Ctrl+U)      Unseal Blind R1 past straggler once >= 2 takes finish',
  '  /budget +<n>             Extend room turn budget',
  '  /pause | /continue       Pause before next round / resume scheduling',
  '  /recover retry|unseal|r2 Recover an interrupted round after resume',
  '  /stop [agent|all]        Cancel active turn(s)',
  '  /export [md|jsonl] [path] Export redacted transcript',
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
  const theme = useMemo(() => createTheme(), []);

  const [staticItems, setStaticItems] = useState<StaticEntry[]>(() => {
    const intro: StaticEntry[] = [
      {
        key: 'banner',
        sender: 'CHAYXONA',
        meta: 'READ-ONLY ROOM',
        body: `Room ${service.room.id} · Repo: ${service.room.repoPath} · Agents: ${service.room.agents.join(', ')}\nNotice: Prompts and repository context are sent to your selected external CLI vendors.${dirtyRepoWarning ? '\nWarning: Working tree has uncommitted changes.' : ''}`,
      },
    ];
    const recovery = service.inspectRecoveryState();
    if (recovery?.kind === 'incomplete_blind_r1') {
      intro.push({
        key: 'recovery-banner',
        sender: 'RECOVERY',
        meta: `R${recovery.roundId} INTERRUPTED`,
        body: `Blind Round 1 was interrupted (completed: ${recovery.completedAgents.join(', ') || 'none'}; interrupted: ${recovery.interruptedAgents.join(', ')}).\nCompleted takes remain sealed. Run \`/recover retry\` to retry interrupted agents or \`/recover unseal\` to reveal partial takes.`,
      });
    } else if (recovery?.kind === 'pending_r2') {
      intro.push({
        key: 'recovery-banner',
        sender: 'RECOVERY',
        meta: `R${recovery.roundId} PENDING R2`,
        body: `Round 1 was revealed before exit. Run \`/recover r2\` to run Cross-Exam Round 2 with ${recovery.completedAgents.join(', ')}.`,
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
  const seqRef = useRef(0);

  const pushSystemItem = (body: string, label = 'SYSTEM', isDiff = false): void => {
    seqRef.current += 1;
    setStaticItems((prev) => [
      ...prev,
      { key: `sys-${Date.now()}-${seqRef.current}`, sender: label, meta: '', body, isDiff },
    ]);
  };

  // Coalesce streaming text deltas at ~20fps (50ms)
  useEffect(() => {
    const timer = setInterval(() => {
      const buf = previewBufRef.current;
      if (Object.keys(buf).length > 0) {
        setLivePreview({ ...buf });
      }
    }, 50);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onMessage = (msg: MessageRecord): void => {
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
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'running', detail: 'thinking...' } }));
      } else if (ev.type === 'tool.started') {
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'running', detail: `tool:${ev.toolName}` } }));
      } else if (ev.type === 'text.delta') {
        previewBufRef.current[a] = ((previewBufRef.current[a] ?? '') + ev.delta).slice(-400);
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'streaming', detail: 'streaming...' } }));
      } else if (ev.type === 'turn.completed') {
        delete previewBufRef.current[a];
        setLivePreview({ ...previewBufRef.current });
        setAgentStates((prev) => ({ ...prev, [a]: { status: 'done', detail: 'done' } }));
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

  useInput(
    (_ch, key) => {
      if (key.tab && !showFindings) {
        setShowFindings(true);
        return;
      }
      if (key.ctrl && _ch === 'u') {
        service.unsealStraggler();
        return;
      }
      if (key.ctrl && _ch === 'c') {
        if (service.isRunning()) {
          service.stop('all');
        } else {
          onExitCleanup();
          exit();
        }
      }
    },
    { isActive: !showFindings },
  );

  const handleSubmit = (raw: string): void => {
    const trimmed = raw.trim();
    setInput('');
    if (!trimmed) return;

    if (trimmed === '/quit' || trimmed === '/exit') {
      service.stop('all');
      onExitCleanup();
      exit();
      return;
    }
    if (trimmed === '/help') {
      pushSystemItem(HELP_TEXT, 'HELP');
      return;
    }
    if (trimmed === '/findings') {
      setShowFindings((v) => !v);
      return;
    }
    if (trimmed === '/summary') {
      pushSystemItem(service.buildLocalSummary(), 'SUMMARY');
      return;
    }
    if (trimmed === '/diff') {
      const latest = taskService?.getLatestTask();
      if (!latest || !latest.activeRevisionId) {
        setNotice({ type: 'warning', text: 'No active task revision to diff yet.' });
        return;
      }
      pushSystemItem(`Active revision: ${latest.activeRevisionId} (state: ${latest.state})`, 'DIFF', true);
      return;
    }
    if (trimmed === '/pause') {
      service.pause();
      return;
    }
    if (trimmed === '/continue') {
      void service.continueScheduling().catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }
    if (trimmed === '/unseal') {
      service.unsealStraggler();
      return;
    }
    if (trimmed.startsWith('/recover')) {
      const sub = trimmed.slice(8).trim().toLowerCase();
      if (sub === 'retry') {
        void service.recoverRetryInterrupted().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else if (sub === 'unseal') {
        void service.recoverUnsealAndContinue().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else if (sub === 'r2') {
        void service.recoverResumePendingR2().catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      } else {
        setNotice({ type: 'warning', text: 'Usage: /recover retry | /recover unseal | /recover r2' });
      }
      return;
    }
    if (trimmed.startsWith('/stop')) {
      const arg = trimmed.slice(5).trim();
      if (arg === 'claude' || arg === 'codex' || arg === 'agy') {
        service.stop(arg);
      } else {
        service.stop('all');
      }
      return;
    }
    if (trimmed.startsWith('/budget')) {
      const m = /^\+?\s*(\d+)$/.exec(trimmed.slice(7).trim());
      const delta = m ? Number.parseInt(m[1], 10) : 12;
      service.extendBudget(delta);
      return;
    }
    if (trimmed.startsWith('/export')) {
      const parts = trimmed.split(/\s+/).slice(1);
      const format = parts[0] === 'jsonl' ? 'jsonl' : 'md';
      const defaultPath = path.join(dataDir, 'exports', `${service.room.id}.${format}`);
      const targetPath = parts[1] ? path.resolve(parts[1]) : defaultPath;
      if (!allowInRepoExport && isPathInside(targetPath, service.room.repoPath)) {
        pushSystemItem(
          `Refused to export inside target repo (${targetPath}). Choose a path outside the repo or restart with --allow-in-repo.`,
          'ERROR',
        );
        return;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(targetPath, service.exportRoom(format), 'utf8');
      pushSystemItem(`Exported ${format} transcript to ${targetPath}`, 'EXPORT');
      return;
    }

    if (service.isRunning() && round?.phase === 'blind_r1') {
      if (trimmed.startsWith('/') || trimmed.startsWith('@')) {
        setNotice({
          type: 'warning',
          text: 'Blind Round 1 is running: only plain-text R2 steering notes or /stop, /pause, /unseal are allowed.',
        });
        return;
      }
      service.queueSteeringNote(trimmed);
      setQueuedSteeringCount((c) => c + 1);
      return;
    }

    if (service.isRunning()) {
      setNotice({ type: 'warning', text: 'Turns are still running. Wait for completion or run /stop.' });
      return;
    }

    if (trimmed.startsWith('/task')) {
      const desc = trimmed.slice(5).trim();
      if (!desc || !taskService) {
        setNotice({ type: 'warning', text: taskService ? 'Usage: /task <description>' : 'Task service unavailable.' });
        return;
      }
      void taskService
        .startTask(desc)
        .then(({ task, approval }) => {
          pushSystemItem(
            `Plan v${task.planVersion} (${approval.id}):\n${task.planText ?? ''}\n\nRun /approve ${approval.id} or /reject ${approval.id} <reason>`,
            `TASK ${task.id}`,
          );
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (trimmed.startsWith('/approve')) {
      const id = trimmed.slice(8).trim();
      if (!id || !taskService) {
        setNotice({ type: 'warning', text: 'Usage: /approve <approval-id>' });
        return;
      }
      void taskService
        .approve(id)
        .then((res) => {
          if (res.revision?.diffPatch) {
            pushSystemItem(res.revision.diffPatch.slice(0, 6000), `DIFF ${res.revision.id}`, true);
          }
          pushSystemItem(
            `Task ${res.task.id} -> ${res.task.state}${res.revision ? ` (rev ${res.revision.id})` : ''}${res.finalApproval ? `\nRun /approve ${res.finalApproval.id} to unlock /apply.` : ''}`,
            'TASK',
          );
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (trimmed.startsWith('/reject')) {
      const rest = trimmed.slice(7).trim();
      const [id, ...reasonParts] = rest.split(/\s+/);
      const reason = reasonParts.join(' ') || 'Rejected by owner';
      if (!id || !taskService) {
        setNotice({ type: 'warning', text: 'Usage: /reject <approval-id> <reason>' });
        return;
      }
      void taskService
        .rejectApproval(id, reason)
        .then(({ task, nextApproval }) => {
          pushSystemItem(
            `Revised Plan v${task.planVersion} (${nextApproval.id}):\n${task.planText ?? ''}`,
            `TASK ${task.id}`,
          );
        })
        .catch((err: unknown) => {
          pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
        });
      return;
    }

    if (trimmed.startsWith('/apply')) {
      const revId = trimmed.slice(6).trim();
      if (!revId || !taskService) {
        setNotice({ type: 'warning', text: 'Usage: /apply <revision-id>' });
        return;
      }
      try {
        const done = taskService.applyRevision(revId);
        pushSystemItem(`Applied ${revId} cleanly. Task ${done.id} is COMPLETED.`, 'APPLY');
      } catch (err: unknown) {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      }
      return;
    }

    if (trimmed.startsWith('/debate')) {
      const topic = trimmed.slice(7).trim();
      if (!topic) {
        setNotice({ type: 'warning', text: 'Usage: /debate <topic>' });
        return;
      }
      void service.runDebateOrAudit('debate', topic).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    if (trimmed.startsWith('/audit')) {
      const rest = trimmed.slice(6).trim();
      const [first, ...others] = rest ? rest.split(/\s+/) : [];
      const mode: AuditMode | undefined =
        first === 'diff' || first === 'staged' || first === 'head' ? first : undefined;
      const focus = mode ? others.join(' ') : rest;
      void service.runDebateOrAudit('audit', focus, mode).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    const mentionMatch = /^@(claude|codex|agy|all)\s+([\s\S]+)$/i.exec(trimmed);
    if (mentionMatch) {
      const target = mentionMatch[1].toLowerCase();
      const body = mentionMatch[2].trim();
      const recipients: AgentId[] = target === 'all' ? [...service.room.agents] : [target as AgentId];
      void service.runFreeform(recipients, body).catch((err: unknown) => {
        pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
      });
      return;
    }

    void service.runFreeform([...service.room.agents], trimmed).catch((err: unknown) => {
      pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
    });
  };

  const budget = service.getBudgetStatus();
  const isBlind = round?.phase === 'blind_r1';
  const phaseLabel = round ? round.phase.toUpperCase() : 'IDLE';
  const frameBorderColor = isBlind ? theme.borderBlind : service.isRunning() ? theme.borderActive : theme.border;
  const noticeColor =
    notice?.type === 'error' ? theme.error : notice?.type === 'warning' ? theme.warning : theme.muted;

  return (
    <Box flexDirection="column">
      {/* 1. Immutable completed transcript in standard terminal buffer */}
      <Static items={staticItems}>
        {(item) => {
          const senderColor = theme.senderColor(item.sender);
          return (
            <Box key={item.key} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text bold color={senderColor}>
                  ● {item.sender}
                </Text>
                {item.meta ? <Text color={theme.muted}>({item.meta})</Text> : null}
              </Box>
              {item.isDiff ? (
                <Box flexDirection="column" paddingLeft={2}>
                  {item.body.split('\n').map((line, i) => (
                    <Text key={i} color={theme.diffLineColor(line)}>
                      {line}
                    </Text>
                  ))}
                </Box>
              ) : (
                <Box paddingLeft={2}>
                  <Text>{item.body}</Text>
                </Box>
              )}
            </Box>
          );
        }}
      </Static>

      {/* 2. Dynamic bottom region */}
      <Box flexDirection="column" borderStyle="round" borderColor={frameBorderColor} paddingX={1}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold color={theme.brand}>
              ☕ CHAYXONA
            </Text>
            <Text color={theme.muted}>/</Text>
            <Text bold>{path.basename(service.room.repoPath)}</Text>
            <Text color={theme.muted}>({service.room.id})</Text>
            <Text bold color={theme.readOnlyBadge}>
              [READ-ONLY]
            </Text>
          </Box>
          <Box gap={1}>
            <Text bold color={isBlind ? theme.borderBlind : theme.phaseBadge}>
              {phaseLabel}
            </Text>
            <Text color={theme.muted}>
              · Turns {budget.used}/{budget.max}
            </Text>
          </Box>
        </Box>

        <Box gap={2} flexWrap="wrap" marginTop={0}>
          {service.room.agents.map((a) => {
            const st = agentStates[a] ?? { status: 'idle', detail: '' };
            const { glyph, color: glyphColor } = theme.statusGlyph(st.status);
            const agentColor = theme.senderColor(a);
            return (
              <Box key={a} gap={1}>
                <Text color={glyphColor}>{glyph}</Text>
                <Text bold color={st.status === 'idle' ? theme.muted : agentColor}>
                  {a.toUpperCase()}
                </Text>
                <Text color={st.detail.startsWith('tool:') ? theme.tool : theme.muted}>
                  {st.detail || st.status}
                </Text>
              </Box>
            );
          })}
        </Box>

        {isBlind ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={theme.borderBlind}>
              ◆ BLIND ROUND 1 — Takes sealed until all finish ([Ctrl+U] unseal straggler)
            </Text>
            {queuedSteeringCount > 0 ? (
              <Text color={theme.phaseBadge}>↳ Queued for R2: {queuedSteeringCount} steering note(s)</Text>
            ) : null}
          </Box>
        ) : null}

        {!isBlind && Object.keys(livePreview).length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {Object.entries(livePreview).map(([agent, preview]) =>
              preview ? (
                <Box key={agent} gap={1}>
                  <Text bold color={theme.senderColor(agent)}>
                    {agent.toUpperCase()}
                  </Text>
                  <Text color={theme.muted}>{preview.replace(/\s+/g, ' ').slice(-110)}</Text>
                </Box>
              ) : null,
            )}
          </Box>
        ) : null}

        {notice ? <Text color={noticeColor}>ℹ {notice.text}</Text> : null}

        {showFindings ? (
          <FindingsPanel
            findings={findings}
            active={showFindings}
            theme={theme}
            onClose={() => setShowFindings(false)}
          />
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Box flexGrow={1}>
            <Text bold color={isBlind ? theme.borderBlind : theme.prompt}>
              {isBlind ? '[R2 steer] › ' : '› '}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              focus={!showFindings}
              placeholder={isBlind ? 'Type a steering note for Round 2...' : '/debate <topic>, /audit, /task, @agent, or /help'}
            />
          </Box>
          <Text color={findings.length > 0 && !isBlind ? theme.brand : theme.muted}>
            [Tab] Findings({isBlind ? 'sealed' : findings.length})
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
