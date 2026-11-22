import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, parseEnv } from '@/lib/env';

function validEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    GEMINI_API_KEY: 'gemini-key',
    RATE_LIMIT_SALT: 'rate-limit-salt',
    CRON_SECRET: 'cron-secret',
    ...overrides,
  };
}

describe('parseEnv', () => {
  it('applies defaults for optional server constants', () => {
    const env = parseEnv(validEnv());

    expect(env.MAX_PDF_PAGES).toBe(100);
    expect(env.MATCH_THRESHOLD).toBe(0.35);
    expect(env.MAX_PDF_BYTES).toBe(15_728_640);
    expect(env.GEMINI_CHAT_MODEL).toBe('gemini-3.5-flash-lite');
    expect(env.GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
  });

  it('coerces numeric strings', () => {
    const env = parseEnv(
      validEnv({
        MAX_PDF_PAGES: '7',
        MATCH_THRESHOLD: '0.5',
        DOC_TTL_HOURS: '48',
      }),
    );

    expect(env.MAX_PDF_PAGES).toBe(7);
    expect(env.MATCH_THRESHOLD).toBe(0.5);
    expect(env.DOC_TTL_HOURS).toBe(48);
  });

  it('throws a readable error when a secret is empty', () => {
    expect(() => parseEnv(validEnv({ GEMINI_API_KEY: '' }))).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('rejects an invalid Supabase URL', () => {
    expect(() =>
      parseEnv(validEnv({ NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })),
    ).toThrow();
  });

  it('rejects a threshold outside 0..1', () => {
    expect(() => parseEnv(validEnv({ MATCH_THRESHOLD: '1.5' }))).toThrow();
  });

  it('treats empty numeric values as missing and applies defaults', () => {
    const env = parseEnv(
      validEnv({ MATCH_THRESHOLD: '', MAX_PDF_PAGES: '' }),
    );

    expect(env.MATCH_THRESHOLD).toBe(0.35);
    expect(env.MAX_PDF_PAGES).toBe(100);
  });
});

describe('getEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the same cached object on repeated calls', () => {
    for (const [key, value] of Object.entries(validEnv())) {
      if (value !== undefined) {
        vi.stubEnv(key, value);
      }
    }

    expect(getEnv()).toBe(getEnv());
  });
});
