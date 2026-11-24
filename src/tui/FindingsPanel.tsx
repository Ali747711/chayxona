import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { groupFindings } from '../domain/findings.js';
import type { FindingRecord } from '../domain/types.js';
import type { TuiTheme } from './theme.js';

export interface FindingsPanelProps {
  findings: readonly FindingRecord[];
  active: boolean;
  theme: TuiTheme;
  onClose: () => void;
}

export const FindingsPanel: React.FC<FindingsPanelProps> = ({ findings, active, theme, onClose }) => {
  const grouped = groupFindings(findings);
  const flat = grouped.flatMap((g) => g.items.map((item) => ({ group: g.group, item })));
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (input, key) => {
      if (!active) return;
      if (key.tab || key.escape) {
        onClose();
        return;
      }
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((prev) => (flat.length === 0 ? 0 : Math.min(flat.length - 1, prev + 1)));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      }
    },
    { isActive: active },
  );

  const clampedIdx = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const windowStart = Math.max(0, clampedIdx - 4);
  const visible = flat.slice(windowStart, windowStart + 8);
  const dissentCount = flat.filter((f) => f.item.dissentsFrom.length > 0).length;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={theme.brand} wrap="truncate-end">
            FINDINGS &amp; DISSENT ({flat.length})
          </Text>
          {dissentCount > 0 ? (
            <Text bold color={theme.dissent} wrap="truncate-end">
              | {dissentCount} dissent
            </Text>
          ) : null}
        </Box>
        <Text color={theme.muted} wrap="truncate-end">[j/k] nav | [Tab/Esc] back</Text>
      </Box>
      {flat.length === 0 ? (
        <Text color={theme.muted}>No visible findings yet. Run /debate or /audit to gather cross-model findings.</Text>
      ) : (
        visible.map((entry, idx) => {
          const absIdx = windowStart + idx;
          const isSelected = absIdx === clampedIdx;
          const f = entry.item;
          const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'General';
          const sevColor = theme.severityColor(f.severity);
          const agentColor = theme.senderColor(f.agentId);

          return (
            <Box key={f.id} flexDirection="column" marginTop={idx === 0 ? 1 : 0}>
              <Box gap={1}>
                <Text bold color={isSelected ? theme.brand : theme.muted}>
                  {isSelected ? '>' : ' '}
                </Text>
                <Text bold color={sevColor} inverse={isSelected}>
                  [{f.severity.toUpperCase()}]
                </Text>
                <Text bold color={agentColor}>
                  {f.canonicalId}
                </Text>
                <Text color={theme.muted}>({loc})</Text>
                <Text bold={isSelected}>{f.summary}</Text>
                {f.dissentsFrom.length > 0 ? (
                  <Text bold color={theme.dissent}>
                    [DISSENT vs {f.dissentsFrom.join(',')}]
                  </Text>
                ) : null}
              </Box>
              {isSelected && f.evidence ? (
                <Text color={theme.muted}>    evidence: {f.evidence}</Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
};
