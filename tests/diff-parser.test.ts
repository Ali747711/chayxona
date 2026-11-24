import { describe, expect, it } from 'vitest';
import {
  filterDiffFiles,
  formatDiffOverview,
  parseGitDiff,
} from '../src/orchestrator/diff-parser.js';

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcdef 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,7 @@
 import fs from 'node:fs';
-import path from 'node:path';
+import path from 'path';
+import { z } from 'zod';
+
 export const a = 1;
diff --git a/tests/index.test.ts b/tests/index.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/index.test.ts
@@ -0,0 +1,5 @@
+import { test, expect } from 'vitest';
+
+test('sample', () => {
+  expect(true).toBe(true);
+});
`;

describe('diff-parser', () => {
  it('parses multi-file diffs and computes accurate additions and deletions', () => {
    const parsed = parseGitDiff(sampleDiff);
    expect(parsed.files).toHaveLength(2);

    const f1 = parsed.files[0];
    expect(f1.file).toBe('src/index.ts');
    expect(f1.additions).toBe(3);
    expect(f1.deletions).toBe(1);
    expect(f1.hunks).toHaveLength(1);
    expect(f1.hunks[0].header).toContain('@@ -1,5 +1,7 @@');

    const f2 = parsed.files[1];
    expect(f2.file).toBe('tests/index.test.ts');
    expect(f2.additions).toBe(5);
    expect(f2.deletions).toBe(0);

    expect(parsed.totalAdditions).toBe(8);
    expect(parsed.totalDeletions).toBe(1);
  });

  it('filters files by 1-based index or search query substring', () => {
    const parsed = parseGitDiff(sampleDiff);

    // 1-based index
    const byIndex1 = filterDiffFiles(parsed, '1');
    expect(byIndex1).toHaveLength(1);
    expect(byIndex1[0].file).toBe('src/index.ts');

    const byIndex2 = filterDiffFiles(parsed, '2');
    expect(byIndex2).toHaveLength(1);
    expect(byIndex2[0].file).toBe('tests/index.test.ts');

    // Substring match
    const byQuery = filterDiffFiles(parsed, 'test');
    expect(byQuery).toHaveLength(1);
    expect(byQuery[0].file).toBe('tests/index.test.ts');

    // Missing query returns all
    expect(filterDiffFiles(parsed)).toHaveLength(2);
  });

  it('formats clean overview table with totals and file list', () => {
    const parsed = parseGitDiff(sampleDiff);
    const overview = formatDiffOverview(parsed);
    expect(overview).toContain('Diff Overview · 2 file(s) changed (+8 -1):');
    expect(overview).toContain('1. src/index.ts  (+3 -1)');
    expect(overview).toContain('2. tests/index.test.ts  (+5 -0)');
    expect(overview).toContain('Tip: Run `/diff <number|filename>`');
  });

  it('handles clean / empty diff gracefully', () => {
    const parsed = parseGitDiff('');
    expect(parsed.files).toHaveLength(0);
    expect(parsed.totalAdditions).toBe(0);
    expect(parsed.totalDeletions).toBe(0);
    expect(formatDiffOverview(parsed)).toBe('No changes detected (clean diff).');
  });
});
