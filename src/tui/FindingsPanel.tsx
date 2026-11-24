import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { groupFindings } from '../domain/findings.js';
import type { FindingRecord } from '../domain/types.js';

export interface FindingsPanelProps {
  findings: readonly FindingRecord[];
  active: boolean;
  onClose: () => void;
}

export const FindingsPanel: React.FC<FindingsPanelProps> = ({ findings, active, onClose }) => {
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

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold>FINDINGS &amp; DISSENT ({flat.length})</Text>
        <Text dimColor>[j/k] navigate · [Tab/Esc] back to composer</Text>
      </Box>
      {flat.length === 0 ? (
        <Text dimColor>No visible findings yet. Run /debate or /audit to gather cross-model findings.</Text>
      ) : (
        visible.map((entry, idx) => {
          const absIdx = windowStart + idx;
          const isSelected = absIdx === clampedIdx;
          const f = entry.item;
          const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'General';
          const dissentTag = f.dissentsFrom.length > 0 ? ` [DISSENT vs ${f.dissentsFrom.join(',')}]` : '';
          return (
            <Box key={f.id} flexDirection="column">
              <Text inverse={isSelected}>
                {isSelected ? '> ' : '  '}[{f.severity.toUpperCase()}] {f.canonicalId} ({loc}): {f.summary}
                {dissentTag}
              </Text>
              {isSelected && f.evidence ? <Text dimColor>    evidence: {f.evidence}</Text> : null}
            </Box>
          );
        })
      )}
    </Box>
  );
};
