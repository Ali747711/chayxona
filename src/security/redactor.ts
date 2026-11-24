const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic / Stripe-style secret keys
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  // GitHub PATs / fine-grained tokens
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  // AWS Access Key IDs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Bearer tokens in headers/logs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  // PEM private key blocks (multiline)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Generic inline key=value secrets
  /\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY))\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
];

const ENV_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const TRIVIAL_VALUES = new Set(['true', 'false', 'null', 'undefined', 'none', 'development', 'production', 'localhost']);

export class SecretRedactor {
  private readonly envValues: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const values = new Set<string>();
    for (const [name, value] of Object.entries(env)) {
      if (!value || value.length < 8) continue;
      if (!ENV_NAME_PATTERN.test(name)) continue;
      if (TRIVIAL_VALUES.has(value.toLowerCase())) continue;
      values.add(value);
    }
    // Longest first so partial substrings don't mask longer tokens
    this.envValues = [...values].sort((a, b) => b.length - a.length);
  }

  redact(input: string): string {
    if (!input) return input;
    let out = input;
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, '[REDACTED]');
    }
    for (const val of this.envValues) {
      if (out.includes(val)) {
        out = out.split(val).join('[REDACTED]');
      }
    }
    return out;
  }

  /**
   * 128-byte sliding-window stream redactor so tokens split across
   * consecutive streaming deltas cannot leak before replacement.
   */
  createStreamRedactor(windowChars = 128): {
    push(chunk: string): string;
    flush(): string;
  } {
    let tail = '';
    return {
      push: (chunk: string): string => {
        if (!chunk) return '';
        const combined = this.redact(tail + chunk);
        if (combined.length <= windowChars) {
          tail = combined;
          return '';
        }
        const emitLen = combined.length - windowChars;
        const emit = combined.slice(0, emitLen);
        tail = combined.slice(emitLen);
        return emit;
      },
      flush: (): string => {
        const finalOut = this.redact(tail);
        tail = '';
        return finalOut;
      },
    };
  }
}
