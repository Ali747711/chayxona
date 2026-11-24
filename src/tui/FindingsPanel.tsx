import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { groupFindings } from '../domain/findings.js';
import type { FindingRecord, FindingSeverity } from '../domain/types.js';
import type { TuiTheme } from './theme.js';

export interface FindingsPanelProps {
  findings: readonly FindingRecord[];
  active: boolean;
  theme: TuiTheme;
  maxVisible?: number;
  onClose: () => void;
  onAction?: (action: 'task' | 'debate', finding: FindingRecord) => void;
}

export const FindingsPanel: React.FC<FindingsPanelProps> = ({
  findings,
  active,
  theme,
  maxVisible = 6,
  onClose,
  onAction,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedFinding, setExpandedFinding] = useState<FindingRecord | null>(null);
  const [dissentFilterOnly, setDissentFilterOnly] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<FindingSeverity | null>(null);

  const filteredFindings = findings.filter((f) => {
    if (dissentFilterOnly && f.dissentsFrom.length === 0) return false;
    if (severityFilter && f.severity !== severityFilter) return false;
    return true;
  });

  const grouped = groupFindings(filteredFindings);
  const flat = grouped.flatMap((g) => g.items.map((item) => ({ group: g.group, item })));
  const clampedIdx = Math.min(selectedIndex, Math.max(0, flat.length - 1));

  useInput(
    (input, key) => {
      if (!active) return;

      // When Detail Modal is open
      if (expandedFinding) {
        if (key.escape || key.return || input === 'b' || input === 'q') {
          setExpandedFinding(null);
          return;
        }
        if (input === 't') {
          onAction?.('task', expandedFinding);
          onClose();
          return;
        }
        if (input === 'd') {
          onAction?.('debate', expandedFinding);
          onClose();
          return;
        }
        return;
      }

      // When in List View
      if (key.tab || key.escape) {
        onClose();
        return;
      }
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((prev) => (flat.length === 0 ? 0 : Math.min(flat.length - 1, prev + 1)));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.return || input === ' ') {
        if (flat[clampedIdx]) {
          setExpandedFinding(flat[clampedIdx].item);
        }
      } else if (input === 't') {
        if (flat[clampedIdx]) {
          onAction?.('task', flat[clampedIdx].item);
          onClose();
        }
      } else if (input === 'd') {
        setDissentFilterOnly((prev) => !prev);
        setSelectedIndex(0);
      } else if (input === '1') {
        setSeverityFilter((prev) => (prev === 'critical' ? null : 'critical'));
        setSelectedIndex(0);
      } else if (input === '2') {
        setSeverityFilter((prev) => (prev === 'high' ? null : 'high'));
        setSelectedIndex(0);
      } else if (input === '3') {
        setSeverityFilter((prev) => (prev === 'medium' ? null : 'medium'));
        setSelectedIndex(0);
      } else if (input === '0') {
        setSeverityFilter(null);
        setDissentFilterOnly(false);
        setSelectedIndex(0);
      }
    },
    { isActive: active },
  );

  // If Detail View is active, render the dedicated Detail Modal
  if (expandedFinding) {
    const f = expandedFinding;
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'General / Architecture';
    const sevColor = theme.severityColor(f.severity);
    const agentColor = theme.senderColor(f.agentId);

    return (
      <Box flexDirection="column" borderStyle="double" borderColor={theme.brand} paddingX={1} marginTop={1}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold color={sevColor} inverse>
              [{f.severity.toUpperCase()}]
            </Text>
            <Text bold color={theme.brand}>
              {f.canonicalId}
            </Text>
            <Text color={agentColor}>reported by {f.agentId.toUpperCase()}</Text>
          </Box>
          <Text color={theme.muted}>[Esc / Enter] Back to list</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold color={theme.prompt}>Location: </Text>
          <Text color={theme.muted}>{loc}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.prompt}>Summary:</Text>
          <Text>{f.summary}</Text>
        </Box>

        {f.evidence ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.prompt}>Evidence / Context:</Text>
            <Text color={theme.muted}>{f.evidence}</Text>
          </Box>
        ) : null}

        {f.dissentsFrom.length > 0 ? (
          <Box marginTop={1}>
            <Text bold color={theme.dissent}>Explicit Dissent vs: </Text>
            <Text bold color={theme.dissent}>{f.dissentsFrom.join(', ')}</Text>
          </Box>
        ) : null}

        {f.agreesWith.length > 0 ? (
          <Box marginTop={1}>
            <Text bold color={theme.brand}>Agrees with: </Text>
            <Text color={theme.brand}>{f.agreesWith.join(', ')}</Text>
          </Box>
        ) : null}

        <Box marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
          <Text bold color={theme.brand}>
            Actions: [t] Fix with /task  |  [d] /debate this finding  |  [Esc] Return
          </Text>
        </Box>
      </Box>
    );
  }

  // Otherwise, render the List View
  const half = Math.floor(maxVisible / 2);
  const windowStart = Math.max(0, Math.min(clampedIdx - half, Math.max(0, flat.length - maxVisible)));
  const visible = flat.slice(windowStart, windowStart + maxVisible);
  const dissentTotal = findings.filter((f) => f.dissentsFrom.length > 0).length;
  const rangeLabel =
    flat.length > maxVisible ? ` (${windowStart + 1}-${windowStart + visible.length} of ${flat.length})` : '';
  const filterDesc = [
    dissentFilterOnly ? 'dissents-only' : null,
    severityFilter ? severityFilter.toUpperCase() : null,
  ].filter(Boolean).join(', ');

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={theme.brand} wrap="truncate-end">
            FINDINGS &amp; DISSENT ({flat.length}){rangeLabel}
          </Text>
          {dissentTotal > 0 ? (
            <Text bold color={theme.dissent} wrap="truncate-end">
              | {dissentTotal} dissent
            </Text>
          ) : null}
          {filterDesc ? (
            <Text bold color={theme.warning} wrap="truncate-end">
              [{filterDesc}]
            </Text>
          ) : null}
        </Box>
        <Text color={theme.muted} wrap="truncate-end">
          [j/k] nav | [Enter] view detail | [t] fix via /task | [d] dissents | [Tab/Esc] back
        </Text>
      </Box>
      {flat.length === 0 ? (
        <Text color={theme.muted}>
          {filterDesc
            ? `No findings match active filter [${filterDesc}]. Press [0] to clear filter.`
            : 'No visible findings yet. Run /debate or /audit to gather cross-model findings.'}
        </Text>
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
