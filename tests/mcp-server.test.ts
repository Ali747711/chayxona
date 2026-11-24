import { describe, expect, it } from 'vitest';
import { createMcpServer, MCP_TOOLS } from '../src/mcp/server.js';

describe('Chayxona MCP Server', () => {
  it('exposes chayxona_debate, chayxona_audit, and chayxona_review_pr tools', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain('chayxona_debate');
    expect(names).toContain('chayxona_audit');
    expect(names).toContain('chayxona_review_pr');
  });

  it('handles JSON-RPC initialize handshake', async () => {
    const server = createMcpServer({ fake: true });
    const resRaw = await server.processLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    );
    expect(resRaw).toBeTruthy();
    const res = JSON.parse(resRaw!);
    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe('chayxona');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('handles tools/list request', async () => {
    const server = createMcpServer({ fake: true });
    const resRaw = await server.processLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    );
    expect(resRaw).toBeTruthy();
    const res = JSON.parse(resRaw!);
    expect(res.id).toBe(2);
    expect(res.result.tools).toHaveLength(3);
  });

  it('executes chayxona_debate via tools/call with fake provider', async () => {
    const server = createMcpServer({ fake: true });
    const resRaw = await server.processLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'chayxona_debate',
          arguments: {
            topic: 'Should we adopt microfrontends?',
            fake: true,
          },
        },
      }),
    );
    expect(resRaw).toBeTruthy();
    const res = JSON.parse(resRaw!);
    expect(res.id).toBe(3);
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].type).toBe('text');
    expect(res.result.content[0].text).toContain('Room Summary');
    expect(res.result.content[0].text).toContain('Findings');
  });

  it('returns clean error payload for unknown tool', async () => {
    const server = createMcpServer({ fake: true });
    const resRaw = await server.processLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'non_existent_tool',
          arguments: {},
        },
      }),
    );
    expect(resRaw).toBeTruthy();
    const res = JSON.parse(resRaw!);
    expect(res.id).toBe(4);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Unknown tool');
  });
});
