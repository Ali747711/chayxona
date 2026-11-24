export type AgentId = 'claude' | 'codex' | 'agy';

export const ALL_AGENTS: readonly AgentId[] = ['claude', 'codex', 'agy'] as const;

export type RoundKind = 'debate' | 'audit' | 'freeform';

export type RoundPhase =
  | 'blind_r1'
  | 'revealed_pending_r2'
  | 'cross_exam_r2'
  | 'freeform'
  | 'done'
  | 'failed_partial'
  | 'cancelled';

export type TurnStatus = 'running' | 'done' | 'error' | 'timeout' | 'interrupted';

export type MessagePhase = 'blind_r1' | 'cross_exam_r2' | 'freeform' | 'steering' | 'system';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AdapterErrorCode =
  | 'auth_required'
  | 'quota'
  | 'unsupported_version'
  | 'permission_denied'
  | 'timeout'
  | 'protocol_error'
  | 'process_exit'
  | 'cancelled'
  | 'unknown';

export interface ProviderCapabilities {
  id: AgentId;
  available: boolean;
  executablePath: string | null;
  version: string | null;
  readOnlySupported: boolean;
  readOnlyProfile: string | null;
  streamingSupported: boolean;
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown';
  error?: string;
}

export type TurnPermissions = 'read-only' | 'workspace-write';

export interface TurnInput {
  roomId: string;
  roundId: number;
  turnId: string;
  agentId: AgentId;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  permissions?: TurnPermissions;
  resumeSessionId?: string;
  warm?: boolean;
}

export type AgentEvent =
  | {
      type: 'turn.started';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      ts: number;
    }
  | {
      type: 'session.bound';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      externalSessionId: string;
      ts: number;
    }
  | {
      type: 'text.delta';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      delta: string;
      ts: number;
    }
  | {
      type: 'text.completed';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      text: string;
      ts: number;
    }
  | {
      type: 'tool.started';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      toolName: string;
      summary: string;
      ts: number;
    }
  | {
      type: 'tool.completed';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      toolName: string;
      ok: boolean;
      summary: string;
      ts: number;
    }
  | {
      type: 'turn.completed';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      text: string;
      inputTokens: number | null;
      outputTokens: number | null;
      ts: number;
    }
  | {
      type: 'turn.failed';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      errorCode: AdapterErrorCode;
      message: string;
      ts: number;
    }
  | {
      type: 'turn.cancelled';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      ts: number;
    }
  | {
      type: 'provider.warning';
      roomId: string;
      roundId: number;
      turnId: string;
      agentId: AgentId;
      message: string;
      ts: number;
    };

export interface FindingRecord {
  id: string;
  roomId: string;
  messageId: string;
  roundId: number;
  phase: 'r1' | 'r2' | 'freeform';
  agentId: AgentId;
  canonicalId: string;
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  summary: string;
  evidence: string;
  agreesWith: string[];
  dissentsFrom: string[];
  createdAt: number;
}

export interface RoomRecord {
  id: string;
  repoPath: string;
  baseSha: string | null;
  status: 'active' | 'closed';
  maxTurns: number;
  agents: AgentId[];
  solo: boolean;
  turnTimeoutMs: number;
  maxConcurrency: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoundRecord {
  id: number;
  roomId: string;
  kind: RoundKind;
  topic: string;
  phase: RoundPhase;
  cancelled: boolean;
  pausedAfterR1: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TurnRecord {
  id: string;
  roomId: string;
  roundId: number;
  roundPhase: MessagePhase;
  agentId: AgentId;
  status: TurnStatus;
  startedAt: number;
  endedAt: number | null;
  errorCode: AdapterErrorCode | null;
}

export interface MessageRecord {
  id: string;
  roomId: string;
  turnId: string | null;
  roundId: number;
  roundPhase: MessagePhase;
  sender: AgentId | 'human' | 'system';
  recipients: string[];
  body: string;
  sealed: boolean;
  seq: number;
  createdAt: number;
}

// --- v2 Safe Write-Mode Domain Types ---

export type TaskState =
  | 'CREATED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'AWAITING_FINAL_APPROVAL'
  | 'READY_TO_APPLY'
  | 'COMPLETED'
  | 'PAUSED'
  | 'INTERRUPTED'
  | 'FAILED'
  | 'CANCELLED';

export type ApprovalKind = 'plan' | 'final';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'invalidated';

export interface TaskRecord {
  id: string;
  roomId: string;
  description: string;
  state: TaskState;
  implementer: AgentId;
  reviewers: AgentId[];
  baseSha: string;
  planVersion: number;
  planText: string | null;
  planHash: string | null;
  activeRevisionId: string | null;
  revisionCount: number;
  maxRevisions: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  subjectHash: string;
  state: ApprovalState;
  actor: 'human';
  reason: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface RevisionRecord {
  id: string;
  taskId: string;
  baseSha: string;
  diffHash: string;
  diffPatch: string;
  worktreePath: string;
  branchName: string;
  createdAt: number;
}

export interface CheckRecord {
  id: string;
  revisionId: string;
  command: string;
  exitCode: number;
  durationMs: number;
  outputExcerpt: string;
  createdAt: number;
}
