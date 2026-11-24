import type { FindingSeverity } from '../domain/types.js';

export type InkColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright';

export interface TuiTheme {
  noColor: boolean;
  brand: InkColor | undefined;
  border: InkColor | undefined;
  borderActive: InkColor | undefined;
  borderBlind: InkColor | undefined;
  readOnlyBadge: InkColor | undefined;
  phaseBadge: InkColor | undefined;
  dissent: InkColor | undefined;
  tool: InkColor | undefined;
  muted: InkColor | undefined;
  prompt: InkColor | undefined;
  success: InkColor | undefined;
  warning: InkColor | undefined;
  error: InkColor | undefined;
  senderColor: (sender: string) => InkColor | undefined;
  severityColor: (severity: FindingSeverity) => InkColor | undefined;
  statusGlyph: (status: string) => { glyph: string; color: InkColor | undefined };
  diffLineColor: (line: string) => InkColor | undefined;
}

export function createTheme(env: NodeJS.ProcessEnv = process.env): TuiTheme {
  const noColor = Boolean(env.NO_COLOR && env.NO_COLOR !== '0');
  const c = (color: InkColor): InkColor | undefined => (noColor ? undefined : color);

  return {
    noColor,
    brand: c('yellowBright'),
    border: c('gray'),
    borderActive: c('cyan'),
    borderBlind: c('magenta'),
    readOnlyBadge: c('cyanBright'),
    phaseBadge: c('yellow'),
    dissent: c('magentaBright'),
    tool: c('cyan'),
    muted: c('gray'),
    prompt: c('cyanBright'),
    success: c('green'),
    warning: c('yellow'),
    error: c('redBright'),

    senderColor(sender: string): InkColor | undefined {
      const key = sender.toUpperCase();
      if (key === 'CLAUDE') return c('yellow');
      if (key === 'CODEX') return c('greenBright');
      if (key === 'AGY' || key === 'ANTIGRAVITY') return c('cyanBright');
      if (key === 'HUMAN' || key === 'YOU') return c('whiteBright');
      if (key === 'CHAYXONA') return c('yellowBright');
      if (key === 'RECOVERY' || key === 'WARNING') return c('yellow');
      if (key === 'ERROR') return c('redBright');
      if (key === 'EXPORT' || key === 'APPLY') return c('green');
      return c('blueBright');
    },

    severityColor(severity: FindingSeverity): InkColor | undefined {
      switch (severity) {
        case 'critical':
          return c('redBright');
        case 'high':
          return c('red');
        case 'medium':
          return c('yellow');
        case 'low':
          return c('cyan');
        case 'info':
          return c('gray');
      }
    },

    statusGlyph(status: string): { glyph: string; color: InkColor | undefined } {
      switch (status) {
        case 'running':
          return { glyph: '*', color: c('yellow') };
        case 'streaming':
          return { glyph: '>', color: c('greenBright') };
        case 'done':
          return { glyph: '+', color: c('green') };
        case 'error':
          return { glyph: 'x', color: c('redBright') };
        case 'cancelled':
          return { glyph: '-', color: c('yellow') };
        default:
          return { glyph: 'o', color: c('gray') };
      }
    },

    diffLineColor(line: string): InkColor | undefined {
      if (line.startsWith('+++') || line.startsWith('---')) return c('whiteBright');
      if (line.startsWith('@@')) return c('cyan');
      if (line.startsWith('+')) return c('green');
      if (line.startsWith('-')) return c('red');
      return undefined;
    },
  };
}
