import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { AppError } from '@/lib/errors';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
};

const GLOBAL_QUOTA_WINDOW_SECONDS = 86_400;

const INTERNAL_ERROR_MESSAGE = 'Terjadi kesalahan pada server.';

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get('x-forwarded-for');
  const firstForwarded = forwardedFor?.split(',')[0]?.trim();

  if (firstForwarded) {
    return firstForwarded;
  }

  const realIp = headers.get('x-real-ip')?.trim();

  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${ip}${salt}`, 'utf8').digest('hex');
}

export function dailyKey(scope: string, now: Date = new Date()): string {
  return `global:${scope}:${now.toISOString().slice(0, 10)}`;
}

export async function checkRateLimit(
  supabase: SupabaseClient<Database>,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { data, error } = await supabase.rpc('rag_check_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  const row = data?.[0];

  if (!row) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return {
    allowed: row.allowed,
    remaining: row.remaining,
    retryAfter: row.retry_after,
  };
}

export async function enforceRateLimit(
  supabase: SupabaseClient<Database>,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await checkRateLimit(supabase, key, limit, windowSeconds);

  if (!result.allowed) {
    throw new AppError(
      'RATE_LIMITED',
      429,
      `Terlalu banyak permintaan. Coba lagi dalam ${result.retryAfter} detik.`,
      result.retryAfter,
    );
  }
}

export async function enforceGlobalQuota(
  supabase: SupabaseClient<Database>,
  scope: string,
  limit: number,
): Promise<void> {
  const result = await checkRateLimit(
    supabase,
    dailyKey(scope),
    limit,
    GLOBAL_QUOTA_WINDOW_SECONDS,
  );

  if (!result.allowed) {
    throw new AppError(
      'GLOBAL_LIMIT_REACHED',
      429,
      'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
    );
  }
}
