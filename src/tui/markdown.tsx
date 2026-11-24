import React from 'react';
import { Box, Text } from 'ink';
import type { TuiTheme } from './theme.js';

export type InlineSegment =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string };

export type MarkdownLine =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code_fence'; lang: string }
  | { kind: 'code'; text: string }
  | { kind: 'paragraph'; segments: InlineSegment[] };

export function parseInlineSegments(line: string): InlineSegment[] {
  // Simplify noisy [label](file:///...) or [label](https://...) links to clean labels
  const cleaned = line.replace(/\[([^\]]+)\]\((?:file:\/\/|https?:\/\/)[^)]+\)/g, '$1');
  const segments: InlineSegment[] = [];
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;

  for (const match of cleaned.matchAll(tokenRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ kind: 'text', value: cleaned.slice(lastIndex, idx) });
    }
    const raw = match[0];
    if (raw.startsWith('**') && raw.endsWith('**')) {
      segments.push({ kind: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      segments.push({ kind: 'code', value: raw.slice(1, -1) });
    }
    lastIndex = idx + raw.length;
  }

  if (lastIndex < cleaned.length) {
    segments.push({ kind: 'text', value: cleaned.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', value: '' }];
}

export function parseMarkdownLines(input: string): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  let inCode = false;

  for (const rawLine of input.split('\n')) {
    const fence = /^```(\S*)\s*$/.exec(rawLine.trim());
    if (fence) {
      inCode = !inCode;
      if (inCode && fence[1]) {
        out.push({ kind: 'code_fence', lang: fence[1] });
      }
      continue;
    }

    if (inCode) {
      out.push({ kind: 'code', text: rawLine });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(rawLine);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    out.push({ kind: 'paragraph', segments: parseInlineSegments(rawLine) });
  }

  return out;
}

export const MarkdownText: React.FC<{ text: string; theme: TuiTheme }> = ({ text, theme }) => {
  const lines = parseMarkdownLines(text);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.kind === 'heading') {
          return (
            <Text key={i} bold color={line.level === 1 ? theme.brand : theme.phaseBadge}>
              {line.text}
            </Text>
          );
        }
        if (line.kind === 'code_fence') {
          return (
            <Text key={i} color={theme.muted}>
              [{line.lang}]
            </Text>
          );
        }
        if (line.kind === 'code') {
          return (
            <Text key={i} color={theme.tool}>
              {'  '}
              {line.text}
            </Text>
          );
        }
        return (
          <Text key={i}>
            {line.segments.map((seg, j) => {
              if (seg.kind === 'bold') {
                return (
                  <Text key={j} bold>
                    {seg.value}
                  </Text>
                );
              }
              if (seg.kind === 'code') {
                return (
                  <Text key={j} color={theme.tool}>
                    {seg.value}
                  </Text>
                );
              }
              return <React.Fragment key={j}>{seg.value}</React.Fragment>;
            })}
          </Text>
        );
      })}
    </Box>
  );
};
