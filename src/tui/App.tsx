import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentId, FindingRecord, MessageRecord, RoundRecord } from '../domain/types.js';
import type { RoomService, RoomStatusEvent } from '../orchestrator/room-service.js';
import type { AuditMode } from '../orchestrator/git-inspector.js';
import { isPathInside } from '../persistence/db.js';
import { FindingsPanel } from './FindingsPanel.js';

export interface StaticEntry {
  key: string;
  sender: string;
  meta: string;
  body: string;
}

export interface AppProps {
  service: RoomService;
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
  '  @claude|@codex|@agy <m>  Targeted single-agent turn',
  '  @all <msg> or plain text Broadcast freeform turn (or R2 steering note during Blind R1)',
  '  /summary                 Deterministic local summary of findings & dissent',
  '  /findings (or Tab)       Toggle Findings & Dissent panel',
  '  /unseal (or Ctrl+U)      Unseal Blind R1 past straggler once >= 2 takes finish',
  '  /budget +<n>             Extend room turn budget',
  '  /pause | /continue       Pause before next round / resume scheduling',
  '  /stop [agent|all]        Cancel active turn(s)',
  '  /export [md|jsonl] [path] Export redacted transcript',
  '  /help | /quit            Show help / exit cleanly',
].join('\n');

export const App: React.FC<AppProps> = ({
  service,
  dataDir,
  initialMessages,
  initialFindings,
  dirtyRepoWarning,
  allowInRepoExport,
  onExitCleanup,
}) => {
  const { exit } = useApp();
  const [staticItems, setStaticItems] = useState<StaticEntry[]>(() => {
    const intro: StaticEntry[] = [
      {
        key: 'banner',
        sender: 'CHAYXONA',
        meta: 'READ-ONLY ROOM',
        body: `Room ${service.room.id} · Repo: ${service.room.repoPath} · Agents: ${service.room.agents.join(', ')}\nNotice: Prompts and repository context are sent to your selected external CLI vendors.${dirtyRepoWarning ? '\nWarning: Working tree has uncommitted changes.' : ''}`,
      },
    ];
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
  const [notice, setNotice] = useState<string>('');
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

  const pushSystemItem = (body: string, label = 'SYSTEM'): void => {
    seqRef.current += 1;
    setStaticItems((prev) => [
      ...prev,
      { key: `sys-${Date.now()}-${seqRef.current}`, sender: label, meta: '', body },
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
      setNotice(n.text);
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

    // Immediate control commands allowed anytime
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

    // Composer state machine during Blind R1
    if (service.isRunning() && round?.phase === 'blind_r1') {
      if (trimmed.startsWith('/') || trimmed.startsWith('@')) {
        setNotice('Blind Round 1 is running: only plain-text R2 steering notes or /stop, /pause, /unseal are allowed.');
        return;
      }
      service.queueSteeringNote(trimmed);
      setQueuedSteeringCount((c) => c + 1);
      return;
    }

    if (service.isRunning()) {
      setNotice('Turns are still running. Wait for completion or run /stop.');
      return;
    }

    // Idle dispatch
    if (trimmed.startsWith('/debate')) {
      const topic = trimmed.slice(7).trim();
      if (!topic) {
        setNotice('Usage: /debate <topic>');
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

    // Plain text when idle -> broadcast 1 freeform turn to each active agent
    void service.runFreeform([...service.room.agents], trimmed).catch((err: unknown) => {
      pushSystemItem(err instanceof Error ? err.message : String(err), 'ERROR');
    });
  };

  const budget = service.getBudgetStatus();
  const isBlind = round?.phase === 'blind_r1';
  const phaseLabel = round ? round.phase.toUpperCase() : 'IDLE';

  return (
    <Box flexDirection="column">
      {/* 1. Immutable completed transcript in standard terminal buffer */}
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.key} flexDirection="column" marginBottom={1}>
            <Text bold>
              {item.sender}
              {item.meta ? ` (${item.meta})` : ''}
            </Text>
            <Text>{item.body}</Text>
          </Box>
        )}
      </Static>

      {/* 2. Dynamic bottom region */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>
            CHAYXONA / {path.basename(service.room.repoPath)} / {service.room.id} [READ-ONLY]
          </Text>
          <Text>
            {phaseLabel} · Turns {budget.used}/{budget.max}
          </Text>
        </Box>

        <Box gap={2} flexWrap="wrap">
          {service.room.agents.map((a) => {
            const st = agentStates[a] ?? { status: 'idle', detail: '' };
            return (
              <Text key={a} dimColor={st.status === 'idle'}>
                [{a.toUpperCase()}] {st.detail || st.status}
              </Text>
            );
          })}
        </Box>

        {isBlind ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>BLIND ROUND 1 — Takes sealed until all finish ([Ctrl+U] unseal straggler)</Text>
            {queuedSteeringCount > 0 ? (
              <Text dimColor>Queued for R2: {queuedSteeringCount} steering note(s)</Text>
            ) : null}
          </Box>
        ) : null}

        {!isBlind && Object.keys(livePreview).length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {Object.entries(livePreview).map(([agent, preview]) =>
              preview ? (
                <Text key={agent} dimColor>
                  {agent.toUpperCase()} ... {preview.replace(/\s+/g, ' ').slice(-120)}
                </Text>
              ) : null,
            )}
          </Box>
        ) : null}

        {notice ? <Text dimColor>{notice}</Text> : null}

        {showFindings ? (
          <FindingsPanel findings={findings} active={showFindings} onClose={() => setShowFindings(false)} />
        ) : null}

        <Box marginTop={1} justifyContent="space-between">
          <Box flexGrow={1}>
            <Text bold>{isBlind ? '[R2 steer] > ' : '> '}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              focus={!showFindings}
              placeholder={isBlind ? 'Type a steering note for Round 2...' : '/debate <topic>, /audit, @agent, or /help'}
            />
          </Box>
          <Text dimColor>
            [Tab] Findings({isBlind ? 'sealed' : findings.length})
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
