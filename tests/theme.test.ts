import { describe, expect, it } from 'vitest';
import { createTheme } from '../src/tui/theme.js';

describe('TUI theme & NO_COLOR compliance', () => {
  it('assigns distinct colors to claude, codex, agy, severities, and diff lines', () => {
    const t = createTheme({});
    expect(t.noColor).toBe(false);
    expect(t.senderColor('claude')).toBe('yellow');
    expect(t.senderColor('codex')).toBe('greenBright');
    expect(t.senderColor('agy')).toBe('cyanBright');
    expect(t.severityColor('critical')).toBe('redBright');
    expect(t.severityColor('high')).toBe('red');
    expect(t.severityColor('medium')).toBe('yellow');
    expect(t.diffLineColor('+added')).toBe('green');
    expect(t.diffLineColor('-removed')).toBe('red');
    expect(t.diffLineColor('@@ -1,2 +1,2 @@')).toBe('cyan');
    expect(t.statusGlyph('done').glyph).toBe('+');
  });

  it('disables all colors cleanly when NO_COLOR=1 is set', () => {
    const t = createTheme({ NO_COLOR: '1' });
    expect(t.noColor).toBe(true);
    expect(t.brand).toBeUndefined();
    expect(t.senderColor('claude')).toBeUndefined();
    expect(t.severityColor('critical')).toBeUndefined();
    expect(t.diffLineColor('+added')).toBeUndefined();
    expect(t.statusGlyph('done')).toEqual({ glyph: '+', color: undefined });
  });
});
