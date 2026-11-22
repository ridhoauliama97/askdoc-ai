// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/documents/[id]/upload-url/route';
import type { Database } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';
import type { DocumentRow } from '@/lib/types';

vi.mock('@/lib/supabase/server', () => ({
  getServiceClient: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    RATE_LIMIT_SALT: 'test-salt',
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '203.0.113.9'),
  hashIp: vi.fn(() => 'ip-hash'),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();

  return {
    ...actual,
    readSessionId: vi.fn(),
  };
});

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
const OTHER_SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DOCUMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STORAGE_PATH = `${SESSION_ID}/${DOCUMENT_ID}.pdf`;
const NOW = new Date('2026-11-22T12:00:00Z');

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

type QueryBuilder = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
};

function queryBuilder(result: QueryResult): QueryBuilder {
  const builder = {} as QueryBuilder;

  for (const method of ['select', 'eq', 'neq', 'gt', 'not', 'order'] as const) {
    builder[method] = vi.fn(() => builder);
  }

  builder.insert = vi.fn(() => Promise.resolve(result));
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = vi.fn(
    (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  );

  return builder;
}

function createSupabaseMock(result: QueryResult) {
  const questions: QueryBuilder[] = [];
  const from = vi.fn(() => {
    const builder = queryBuilder(result);
    questions.push(builder);
    return builder;
  });
  const createSignedUploadUrl = vi.fn().mockResolvedValue({
    data: {
      signedUrl: 'https://storage.test/signed-upload',
      token: 'upload-token',
      path: STORAGE_PATH,
    },
    error: null,
  });
  const storageFrom = vi.fn(() => ({ createSignedUploadUrl }));

  return {
    client: {
      from,
      storage: { from: storageFrom },
    } as unknown as SupabaseClient<Database>,
    from,
    questions,
    storageFrom,
    createSignedUploadUrl,
  };
}

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: DOCUMENT_ID,
    session_id: SESSION_ID,
    file_name: 'Peraturan Perusahaan.pdf',
    file_size: 1_024,
    page_count: null,
    chunk_count: 0,
    status: 'awaiting_upload',
    error_code: null,
    error_message: null,
    storage_path: STORAGE_PATH,
    ingest_lock_until: null,
    created_at: '2026-11-22T11:30:00Z',
    updated_at: '2026-11-22T11:30:00Z',
    expires_at: '2026-11-23T11:30:00Z',
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest(
    `http://localhost:3000/api/documents/${DOCUMENT_ID}/upload-url`,
    {
      method: 'POST',
      headers,
    },
  );
}

function context(id: string = DOCUMENT_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getServiceClient).mockReset();
  vi.mocked(readSessionId).mockReset();
  vi.mocked(enforceRateLimit).mockReset().mockResolvedValue(undefined);
});

describe('POST /api/documents/:id/upload-url', () => {
  it('reissues the signed upload URL for an awaiting_upload document', async () => {
    const supabase = createSupabaseMock({ data: documentRow(), error: null });
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      signedUrl: 'https://storage.test/signed-upload',
      token: 'upload-token',
      path: STORAGE_PATH,
    });

    expect(enforceRateLimit).toHaveBeenCalledWith(
      supabase.client,
      'signed_upload:ip-hash',
      10,
      600,
    );
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.storageFrom).toHaveBeenCalledWith('rag-documents');
    expect(supabase.createSignedUploadUrl).toHaveBeenCalledWith(STORAGE_PATH);
    expect(supabase.questions[0].insert).not.toHaveBeenCalled();
  });

  it('returns 404 for a document owned by another session', async () => {
    const supabase = createSupabaseMock({ data: null, error: null });
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(OTHER_SESSION_ID);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Dokumen tidak ditemukan.' },
    });
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      OTHER_SESSION_ID,
    );
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 409 for a document that is not awaiting upload', async () => {
    const supabase = createSupabaseMock({
      data: documentRow({ status: 'ready' }),
      error: null,
    });
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DOC_NOT_READY', message: 'Dokumen masih diproses.' },
    });
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no session cookie', async () => {
    vi.mocked(readSessionId).mockReturnValue(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it('returns RATE_LIMITED before looking up the document', async () => {
    const supabase = createSupabaseMock({ data: documentRow(), error: null });
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);
    vi.mocked(enforceRateLimit).mockRejectedValue(
      new AppError(
        'RATE_LIMITED',
        429,
        'Terlalu banyak permintaan. Coba lagi dalam 30 detik.',
        30,
      ),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RATE_LIMITED', retryAfter: 30 },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin mutation before issuing a URL', async () => {
    const response = await POST(request({ origin: 'https://evil.example' }), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(getServiceClient).not.toHaveBeenCalled();
  });
});
