import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../src/security/redactor.js';

describe('SecretRedactor', () => {
  it('redacts known token prefixes and PEM blocks', () => {
    const r = new SecretRedactor({});
    const input = [
      'key=sk-proj-1234567890abcdef123456',
      'gh=ghp_1234567890abcdef123456',
      'aws=AKIAIOSFODNN7EXAMPLE',
      'auth=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = r.redact(input);
    expect(out).not.toContain('sk-proj-');
    expect(out).not.toContain('ghp_1234');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('eyJhbGci');
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts matching env vars >= 8 chars while ignoring short or trivial values', () => {
    const r = new SecretRedactor({
      MY_API_KEY: 'super-secret-value-99',
      SHORT_KEY: '123',
      BOOL_SECRET: 'true',
      DEV_TOKEN: 'development',
    });
    const out = r.redact('using super-secret-value-99 and 123 and true in development');
    expect(out).toBe('using [REDACTED] and 123 and true in development');
  });

  it('redacts secrets split across two streaming deltas via sliding window', () => {
    const r = new SecretRedactor({});
    const stream = r.createStreamRedactor(128);
    const p1 = stream.push('hello token is sk-proj-12345678');
    const p2 = stream.push('90abcdef1234567890 world');
    const p3 = stream.flush();
    const combined = p1 + p2 + p3;
    expect(combined).toContain('[REDACTED]');
    expect(combined).not.toContain('sk-proj-');
    expect(combined).toContain('hello token is ');
    expect(combined).toContain(' world');
  });
});
