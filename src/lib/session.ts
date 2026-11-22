import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest, NextResponse } from 'next/server';
import type { Database } from '@/lib/database.types';
import { AppError, INTERNAL_ERROR_MESSAGE } from '@/lib/errors';

export const SESSION_COOKIE = 'askdoc_sid';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readSessionId(request: NextRequest): string | null {
  const value = request.cookies.get(SESSION_COOKIE)?.value;

  if (!value || !UUID_PATTERN.test(value)) {
    return null;
  }

  return value;
}

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function setSessionCookie(
  response: NextResponse,
  sessionId: string,
): void {
  response.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions());
}

export async function ensureSession(
  request: NextRequest,
  supabase: SupabaseClient<Database>,
): Promise<{ sessionId: string; isNew: boolean }> {
  const cookieSessionId = readSessionId(request);

  if (cookieSessionId) {
    const { data, error } = await supabase
      .from('rag_sessions')
      .select('id')
      .eq('id', cookieSessionId)
      .maybeSingle();

    if (error) {
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    if (data) {
      const { error: updateError } = await supabase
        .from('rag_sessions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', data.id);

      if (updateError) {
        throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
      }

      return { sessionId: data.id, isNew: false };
    }
  }

  const sessionId = crypto.randomUUID();
  const { error } = await supabase
    .from('rag_sessions')
    .insert({ id: sessionId });

  if (error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return { sessionId, isNew: true };
}
