import type { AgentId } from '../domain/types.js';

export interface WarmSessionInfo {
  roomId: string;
  agentId: AgentId;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  turnCount: number;
}

export class WarmTransportPool {
  private sessions = new Map<string, WarmSessionInfo>();

  private getKey(roomId: string, agentId: AgentId): string {
    return `${roomId}:${agentId}`;
  }

  get(roomId: string, agentId: AgentId): WarmSessionInfo | undefined {
    return this.sessions.get(this.getKey(roomId, agentId));
  }

  register(roomId: string, agentId: AgentId, sessionId: string): WarmSessionInfo {
    const key = this.getKey(roomId, agentId);
    const existing = this.sessions.get(key);
    const info: WarmSessionInfo = {
      roomId,
      agentId,
      sessionId,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
      turnCount: (existing?.turnCount ?? 0) + 1,
    };
    this.sessions.set(key, info);
    return info;
  }

  clear(roomId?: string): void {
    if (!roomId) {
      this.sessions.clear();
      return;
    }
    for (const [key, session] of this.sessions.entries()) {
      if (session.roomId === roomId) {
        this.sessions.delete(key);
      }
    }
  }

  list(roomId?: string): WarmSessionInfo[] {
    const list = Array.from(this.sessions.values());
    if (!roomId) return list;
    return list.filter((s) => s.roomId === roomId);
  }
}
