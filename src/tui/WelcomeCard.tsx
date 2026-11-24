import React from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import type { AgentRole } from '../domain/roles.js';
import type { AgentId } from '../domain/types.js';
import type { TuiTheme } from './theme.js';

export interface WelcomeCardProps {
  roomId: string;
  repoPath: string;
  agents: readonly AgentId[];
  getRole: (agent: AgentId) => AgentRole;
  dirtyRepo?: boolean;
  cols: number;
  theme: TuiTheme;
}

export const WelcomeCard: React.FC<WelcomeCardProps> = ({
  roomId,
  repoPath,
  agents,
  getRole,
  dirtyRepo,
  cols,
  theme,
}) => {
  const cardWidth = Math.max(48, Math.min(74, cols - 4));
  const repoName = path.basename(repoPath);

  return (
    <Box width="100%" justifyContent="center" marginTop={1} marginBottom={1}>
      <Box
        width={cardWidth}
        flexDirection="column"
        alignItems="center"
        borderStyle="single"
        borderColor={theme.borderActive}
        paddingX={2}
        paddingY={1}
      >
        <Text bold color={theme.brand}>
          C H A Y X O N A
        </Text>
        <Text color={theme.muted}>Cross-CLI Engineering &amp; Debate Room</Text>

        <Box marginTop={1} gap={2} justifyContent="center" flexWrap="wrap">
          {agents.map((a) => (
            <Text key={a}>
              <Text bold color={theme.senderColor(a)}>
                [{a.toUpperCase()}]
              </Text>
              <Text color={theme.muted}> {getRole(a)}</Text>
            </Text>
          ))}
        </Box>

        <Box marginTop={1}>
          <Text color={theme.muted} wrap="truncate-end">
            {repoName} ({roomId}) ·{' '}
            <Text color={dirtyRepo ? theme.warning : theme.success}>
              {dirtyRepo ? 'dirty working tree' : 'clean working tree'}
            </Text>
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1} alignSelf="flex-start" paddingLeft={2}>
          <Text bold color={theme.phaseBadge}>
            Quick start
          </Text>
          {dirtyRepo ? (
            <>
              <Text>
                <Text color={theme.tool}>/audit diff</Text>
                <Text color={theme.muted}>          Review your uncommitted changes</Text>
              </Text>
              <Text>
                <Text color={theme.tool}>/debate &lt;topic&gt;</Text>
                <Text color={theme.muted}>      Blind R1 -&gt; Cross-Exam R2 debate</Text>
              </Text>
              <Text>
                <Text color={theme.tool}>/role &lt;agent&gt; &lt;lens&gt;</Text>
                <Text color={theme.muted}> Switch lens (security, performance...)</Text>
              </Text>
            </>
          ) : (
            <>
              <Text>
                <Text color={theme.tool}>/debate &lt;topic&gt;</Text>
                <Text color={theme.muted}>      Blind R1 -&gt; Cross-Exam R2 debate</Text>
              </Text>
              <Text>
                <Text color={theme.tool}>/audit head</Text>
                <Text color={theme.muted}>          Cross-review the latest commit</Text>
              </Text>
              <Text>
                <Text color={theme.tool}>/task &lt;desc&gt;</Text>
                <Text color={theme.muted}>         Plan -&gt; approve -&gt; worktree -&gt; /apply</Text>
              </Text>
            </>
          )}
        </Box>

        <Box marginTop={1}>
          <Text color={theme.muted} wrap="truncate-end">
            Read-only by default · Prompts sent to your local CLIs · Type /help
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
