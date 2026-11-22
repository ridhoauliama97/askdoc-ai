// @vitest-environment node
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import {
  checkRateLimit,
  dailyKey,
  enforceGlobalQuota,
  enforceRateLimit,
  getClientIp,
  hashIp,
} from '@/lib/rate-limit';

type RateLimitRow = {
  allowed: boolean;
  remaining: number;
  retry_after: number;
};

function rpcClient(result: {
  data: RateLimitRow[] | null;
  error: { message: string } | null;
}) {
  const rpc = vi.fn().mockResolvedValue(result);

  return {
    client: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getClientIp', () => {
  it('uses the first x-forwarded-for value', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.9, 70.41.3.18, 10.0.0.1',
    });

    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('trims whitespace around the forwarded value', () => {
    const headers = new Headers({
      'x-forwarded-for': '  203.0.113.9  , 70.41.3.18',
    });

    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });

    expect(getClientIp(headers)).toBe('198.51.100.7');
  });

  it('returns unknown when no forwarding header exists', () => {
    expect(getClientIp(new Headers())).toBe('unknown');
  });
});

describe('hashIp', () => {
  it('hashes ip and salt with SHA-256', () => {
    const expected = createHash('sha256')
      .update('203.0.113.9rate-limit-salt')
      .digest('hex');

    expect(hashIp('203.0.113.9', 'rate-limit-salt')).toBe(expected);
    expect(hashIp('203.0.113.9', 'rate-limit-salt')).toBe(
      hashIp('203.0.113.9', 'rate-limit-salt'),
    );
  });

  it('differs when the salt changes', () => {
    expect(hashIp('203.0.113.9', 'salt-a')).not.toBe(
      hashIp('203.0.113.9', 'salt-b'),
    );
  });
});

describe('dailyKey', () => {
  it('uses the UTC date of the provided instant', () => {
    expect(dailyKey('chat', new Date('2026-11-22T23:59:00Z'))).toBe(
      'global:chat:2026-11-22',
    );
    expect(dailyKey('chat', new Date('2026-11-23T00:00:00Z'))).toBe(
      'global:chat:2026-11-23',
    );
  });
});

describe('checkRateLimit', () => {
  it('calls the RPC with the exact key, limit, and window', async () => {
    const supabase = rpcClient({
      data: [{ allowed: true, remaining: 9, retry_after: 0 }],
      error: null,
    });

    const result = await checkRateLimit(supabase.client, 'chat:abc', 10, 60);

    expect(result).toEqual({ allowed: true, remaining: 9, retryAfter: 0 });
    expect(supabase.rpc).toHaveBeenCalledWith('rag_check_rate_limit', {
      p_key: 'chat:abc',
      p_limit: 10,
      p_window_seconds: 60,
    });
  });

  it('maps retry_after to retryAfter when denied', async () => {
    const supabase = rpcClient({
      data: [{ allowed: false, remaining: 0, retry_after: 42 }],
      error: null,
    });

    const result = await checkRateLimit(supabase.client, 'chat:abc', 10, 60);

    expect(result).toEqual({ allowed: false, remaining: 0, retryAfter: 42 });
  });

  it('throws INTERNAL_ERROR when the RPC errors', async () => {
    const supabase = rpcClient({
      data: null,
      error: { message: 'database unavailable' },
    });

    const error = await checkRateLimit(
      supabase.client,
      'chat:abc',
      10,
      60,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
      message: 'Terjadi kesalahan pada server.',
    });
  });

  it('throws INTERNAL_ERROR when the RPC returns no rows', async () => {
    const supabase = rpcClient({ data: [], error: null });

    const error = await checkRateLimit(
      supabase.client,
      'chat:abc',
      10,
      60,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('enforceRateLimit', () => {
  it('resolves while the request is under the limit', async () => {
    const supabase = rpcClient({
      data: [{ allowed: true, remaining: 2, retry_after: 0 }],
      error: null,
    });

    await expect(
      enforceRateLimit(supabase.client, 'chat:abc', 12, 60),
    ).resolves.toBeUndefined();
  });

  it('throws RATE_LIMITED with retryAfter when denied', async () => {
    const supabase = rpcClient({
      data: [{ allowed: false, remaining: 0, retry_after: 30 }],
      error: null,
    });

    const error = await enforceRateLimit(
      supabase.client,
      'chat:abc',
      12,
      60,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 30,
      message: 'Terlalu banyak permintaan. Coba lagi dalam 30 detik.',
    });
  });
});

describe('enforceGlobalQuota', () => {
  it('uses the UTC daily key and a 86,400-second window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T23:59:00Z'));
    const supabase = rpcClient({
      data: [{ allowed: true, remaining: 4, retry_after: 0 }],
      error: null,
    });

    await enforceGlobalQuota(supabase.client, 'chat', 5);

    expect(supabase.rpc).toHaveBeenCalledWith('rag_check_rate_limit', {
      p_key: 'global:chat:2026-11-22',
      p_limit: 5,
      p_window_seconds: 86_400,
    });
  });

  it('throws GLOBAL_LIMIT_REACHED when the daily quota is exhausted', async () => {
    const supabase = rpcClient({
      data: [{ allowed: false, remaining: 0, retry_after: 3600 }],
      error: null,
    });

    const error = await enforceGlobalQuota(
      supabase.client,
      'chat',
      300,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'GLOBAL_LIMIT_REACHED',
      status: 429,
      message: 'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
    });
  });
});
