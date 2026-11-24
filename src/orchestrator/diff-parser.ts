export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface DiffFile {
  file: string;
  oldPath: string;
  newPath: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  raw: string;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export function parseGitDiff(rawPatch: string): ParsedDiff {
  const sections = rawPatch.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const section of sections) {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(section);
    const oldPath = headerMatch ? headerMatch[1] : '';
    const newPath = headerMatch ? headerMatch[2] : '';
    const file = newPath || oldPath || 'unknown';

    const hunkParts = section.split(/(?=^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m);
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    for (let i = 1; i < hunkParts.length; i++) {
      const hunkRaw = hunkParts[i];
      const lines = hunkRaw.split('\n');
      const header = lines[0] ?? '';
      const hunkLines = lines.slice(1);

      for (const line of hunkLines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      }

      hunks.push({
        header,
        lines: hunkLines,
      });
    }

    // In case no @@ hunks (e.g. pure new file mode or binary diffs)
    if (hunks.length === 0) {
      const lines = section.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
    }

    totalAdditions += additions;
    totalDeletions += deletions;

    files.push({
      file,
      oldPath,
      newPath,
      additions,
      deletions,
      hunks,
      raw: section,
    });
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
  };
}

export function filterDiffFiles(parsed: ParsedDiff, query?: string): DiffFile[] {
  if (!query || query.trim().length === 0) {
    return parsed.files;
  }

  const q = query.trim().toLowerCase();
  // Check if query is 1-based index (e.g. "1", "2")
  const idx = Number.parseInt(q, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= parsed.files.length) {
    const target = parsed.files[idx - 1];
    return target ? [target] : [];
  }

  return parsed.files.filter(
    (f) =>
      f.file.toLowerCase().includes(q) ||
      f.newPath.toLowerCase().includes(q) ||
      f.oldPath.toLowerCase().includes(q),
  );
}

export function formatDiffOverview(parsed: ParsedDiff): string {
  if (parsed.files.length === 0) {
    return 'No changes detected (clean diff).';
  }

  const lines: string[] = [
    `Diff Overview · ${parsed.files.length} file(s) changed (+${parsed.totalAdditions} -${parsed.totalDeletions}):`,
  ];

  parsed.files.forEach((f, idx) => {
    lines.push(`  ${idx + 1}. ${f.file}  (+${f.additions} -${f.deletions})`);
  });

  lines.push('');
  lines.push('Tip: Run `/diff <number|filename>` to inspect a single file (e.g. `/diff 1`).');
  return lines.join('\n');
}
