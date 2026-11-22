// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  SESSION_COOKIE,
  ensureSession,
  readSessionId,
  sessionCookieOptions,
  setSessionCookie,
} from '@/lib/session';

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
const OTHER_SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestWithCookie(value?: string): NextRequest {
  const headers = new Headers();
  if (value !== undefined) {
    headers.set('cookie', `${SESSION_COOKIE}=${value}`);
  }

  return new NextRequest('http://localhost:3000/api/documents', { headers });
}

function mockSupabase(
  options: {
    existingId?: string | null;
    selectError?: { message: string } | null;
    insertError?: { message: string } | null;
  } = {},
) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: options.existingId ? { id: options.existingId } : null,
    error: options.selectError ?? null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const insert = vi
    .fn()
    .mockResolvedValue({ error: options.insertError ?? null });
  const from = vi.fn().mockReturnValue({ select, insert });

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    from,
    select,
    eq,
    maybeSingle,
    insert,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readSessionId', () => {
  it('returns the cookie value when it is a valid UUID', () => {
    expect(readSessionId(requestWithCookie(SESSION_ID))).toBe(SESSION_ID);
  });

  it('returns null when the cookie is missing', () => {
    expect(readSessionId(requestWithCookie())).toBeNull();
  });

  it('returns null when the cookie is not a valid UUID', () => {
    expect(readSessionId(requestWithCookie('not-a-uuid'))).toBeNull();
  });
});

describe('sessionCookieOptions', () => {
  it('returns hardened cookie options without Secure outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');

    expect(sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
  });

  it('sets Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
  });
});

describe('setSessionCookie', () => {
  it('writes the session id with the hardened cookie options', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const response = NextResponse.json({ ok: true });

    setSessionCookie(response, SESSION_ID);

    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({
      name: SESSION_COOKIE,
      value: SESSION_ID,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(response.headers.get('set-cookie')).toContain('Path=/');
  });
});

describe('ensureSession', () => {
  it('reuses an existing row for the cookie id', async () => {
    const supabase = mockSupabase({ existingId: SESSION_ID });

    const result = await ensureSession(
      requestWithCookie(SESSION_ID),
      supabase.client,
    );

    expect(result).toEqual({ sessionId: SESSION_ID, isNew: false });
    expect(supabase.from).toHaveBeenCalledWith('rag_sessions');
    expect(supabase.select).toHaveBeenCalledWith('id');
    expect(supabase.eq).toHaveBeenCalledWith('id', SESSION_ID);
    expect(supabase.maybeSingle).toHaveBeenCalledOnce();
    expect(supabase.insert).not.toHaveBeenCalled();
  });

  it('creates and inserts a new session when the cookie is absent', async () => {
    const supabase = mockSupabase({ existingId: null });

    const result = await ensureSession(requestWithCookie(), supabase.client);

    expect(result.isNew).toBe(true);
    expect(result.sessionId).toMatch(UUID_PATTERN);
    expect(supabase.from).toHaveBeenCalledWith('rag_sessions');
    expect(supabase.select).not.toHaveBeenCalled();
    expect(supabase.insert).toHaveBeenCalledWith({ id: result.sessionId });
  });

  it('does not trust a cookie id that has no session row', async () => {
    const supabase = mockSupabase({ existingId: null });

    const result = await ensureSession(
      requestWithCookie(OTHER_SESSION_ID),
      supabase.client,
    );

    expect(result.isNew).toBe(true);
    expect(result.sessionId).toMatch(UUID_PATTERN);
    expect(result.sessionId).not.toBe(OTHER_SESSION_ID);
    expect(supabase.eq).toHaveBeenCalledWith('id', OTHER_SESSION_ID);
    expect(supabase.insert).toHaveBeenCalledWith({ id: result.sessionId });
  });

  it('maps a session lookup error to INTERNAL_ERROR', async () => {
    const supabase = mockSupabase({
      selectError: { message: 'database unavailable' },
    });

    const error = await ensureSession(
      requestWithCookie(SESSION_ID),
      supabase.client,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(supabase.insert).not.toHaveBeenCalled();
  });
});
