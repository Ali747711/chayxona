import { describe, expect, it } from 'vitest';
import { parseInlineSegments, parseMarkdownLines } from '../src/tui/markdown.js';

describe('terminal markdown parser', () => {
  it('parses headings, fenced code blocks, bold, inline code, and strips noisy file URLs', () => {
    const md = [
      '## Findings',
      'Check **race condition** in [`room-service.ts`](file:///Users/mac/room-service.ts#L10) using `stop()`.',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');

    const lines = parseMarkdownLines(md);
    expect(lines[0]).toEqual({ kind: 'heading', level: 2, text: 'Findings' });
    expect(lines[1].kind).toBe('paragraph');
    if (lines[1].kind === 'paragraph') {
      expect(lines[1].segments.some((s) => s.kind === 'bold' && s.value === 'race condition')).toBe(true);
      expect(lines[1].segments.some((s) => s.kind === 'code' && s.value === 'room-service.ts')).toBe(true);
      expect(lines[1].segments.some((s) => s.kind === 'code' && s.value === 'stop()')).toBe(true);
    }
    expect(lines[2]).toEqual({ kind: 'code_fence', lang: 'ts' });
    expect(lines[3]).toEqual({ kind: 'code', text: 'const x = 1;' });
  });

  it('handles plain text cleanly', () => {
    expect(parseInlineSegments('plain text')).toEqual([{ kind: 'text', value: 'plain text' }]);
  });
});
