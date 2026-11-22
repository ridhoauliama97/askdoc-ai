// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/documents/route';
import type { Database } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { enforceGlobalQuota, enforceRateLimit } from '@/lib/rate-limit';
import { ensureSession, readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';
import type { DocumentRow } from '@/lib/types';

vi.mock('@/lib/supabase/server', () => ({
  getServiceClient: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    MAX_PDF_BYTES: 15_728_640,
    MAX_DOCS_PER_SESSION: 5,
    RATE_LIMIT_SALT: 'test-salt',
    GLOBAL_DAILY_UPLOADS: 50,
    GLOBAL_ACTIVE_STORAGE_BYTES: 524_288_000,
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '203.0.113.9'),
  hashIp: vi.fn(() => 'ip-hash'),
  enforceRateLimit: vi.fn(),
  enforceGlobalQuota: vi.fn(),
}));

vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();

  return {
    ...actual,
    ensureSession: vi.fn(),
    readSessionId: vi.fn(),
  };
});

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
const NOW = new Date('2026-11-22T12:00:00Z');
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  delete: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
};

function queryBuilder(result: QueryResult): QueryBuilder {
  const builder = {} as QueryBuilder;

  for (const method of ['select', 'eq', 'neq', 'gt', 'not', 'order'] as const) {
    builder[method] = vi.fn(() => builder);
  }

  builder.insert = vi.fn(() => Promise.resolve(result));
  builder.delete = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = vi.fn(
    (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  );

  return builder;
}

function createSupabaseMock(results: QueryResult[]) {
  const questions: QueryBuilder[] = [];
  const queue = [...results];
  const from = vi.fn(() => {
    const builder = queryBuilder(queue.shift() ?? { data: null, error: null });
    questions.push(builder);
    return builder;
  });

  const createSignedUploadUrl = vi.fn().mockResolvedValue({
    data: {
      signedUrl: 'https://storage.test/signed-upload',
      token: 'upload-token',
      path: 'returned-path',
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

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/documents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    session_id: SESSION_ID,
    file_name: 'Peraturan Perusahaan.pdf',
    file_size: 1_024,
    page_count: 12,
    chunk_count: 42,
    status: 'ready',
    error_code: null,
    error_message: null,
    storage_path: `${SESSION_ID}/7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf`,
    ingest_lock_until: null,
    created_at: '2026-11-22T11:00:00Z',
    updated_at: '2026-11-22T11:00:00Z',
    expires_at: '2026-11-23T11:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getServiceClient).mockReset();
  vi.mocked(ensureSession).mockReset();
  vi.mocked(readSessionId).mockReset();
  vi.mocked(enforceRateLimit).mockReset().mockResolvedValue(undefined);
  vi.mocked(enforceGlobalQuota).mockReset().mockResolvedValue(undefined);
});

describe('POST /api/documents', () => {
  it('creates a session and returns a signed upload URL', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: true,
    });

    const request = postRequest({
      fileName: 'Peraturan Perusahaan.pdf',
      fileSize: 1_024,
    });
    const response = await POST(request);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      documentId: string;
      signedUrl: string;
      token: string;
      path: string;
    };

    expect(body.documentId).toMatch(UUID_PATTERN);
    expect(body.signedUrl).toBe('https://storage.test/signed-upload');
    expect(body.token).toBe('upload-token');
    expect(body.path).toBe(`${SESSION_ID}/${body.documentId}.pdf`);

    expect(ensureSession).toHaveBeenCalledWith(request, supabase.client);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      supabase.client,
      'signed_upload:ip-hash',
      10,
      600,
    );
    expect(enforceGlobalQuota).toHaveBeenCalledWith(
      supabase.client,
      'upload',
      50,
    );

    expect(supabase.questions[0].select).toHaveBeenCalledWith(
      'status, created_at, expires_at',
    );
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.questions[1].select).toHaveBeenCalledWith('file_size');
    expect(supabase.questions[2].insert).toHaveBeenCalledWith({
      id: body.documentId,
      session_id: SESSION_ID,
      file_name: 'Peraturan Perusahaan.pdf',
      file_size: 1_024,
      status: 'awaiting_upload',
      storage_path: body.path,
    });

    expect(supabase.storageFrom).toHaveBeenCalledWith('rag-documents');
    expect(supabase.createSignedUploadUrl).toHaveBeenCalledWith(body.path);

    expect(response.cookies.get('askdoc_sid')?.value).toBe(SESSION_ID);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('does not reset the cookie for an existing session', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({ fileName: 'laporan.pdf', fileSize: 2_048 }),
    );

    expect(response.status).toBe(201);
    expect(response.cookies.get('askdoc_sid')).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects an oversize file with FILE_TOO_LARGE', async () => {
    const response = await POST(
      postRequest({ fileName: 'besar.pdf', fileSize: 15_728_641 }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'Ukuran file melebihi 15 MB.',
      },
    });
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('rejects a sixth active document with DOC_LIMIT_REACHED', async () => {
    const activeDocuments = Array.from({ length: 5 }, (_, index) =>
      documentRow({ id: `00000000-0000-4000-8000-00000000000${index}` }),
    );
    const supabase = createSupabaseMock([
      { data: activeDocuments, error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1_024 }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'DOC_LIMIT_REACHED',
        message:
          'Maksimal 5 dokumen aktif. Hapus dokumen lama untuk mengunggah lagi.',
      },
    });
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(enforceGlobalQuota).not.toHaveBeenCalled();
  });

  it('rejects when global active storage would be exceeded', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [{ file_size: 524_288_000 }], error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1 }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'GLOBAL_LIMIT_REACHED',
        message: 'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
      },
    });
    expect(supabase.questions[1].neq).toHaveBeenCalledWith(
      'status',
      'failed',
    );
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects when the global daily upload quota is exhausted', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });
    vi.mocked(enforceGlobalQuota).mockRejectedValue(
      new AppError(
        'GLOBAL_LIMIT_REACHED',
        429,
        'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
        3_600,
      ),
    );

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1_024 }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'GLOBAL_LIMIT_REACHED', retryAfter: 3_600 },
    });
    expect(supabase.questions).toHaveLength(2);
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns INTERNAL_ERROR when the document insert fails', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: { message: 'database unavailable' } },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1_024 }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(supabase.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(supabase.questions).toHaveLength(3);
  });

  it('deletes the inserted row when signing the upload URL fails', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    supabase.createSignedUploadUrl.mockResolvedValueOnce({
      data: null,
      error: { message: 'storage unavailable' },
    });
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1_024 }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });

    const inserted = supabase.questions[2].insert.mock.calls[0]?.[0] as {
      id: string;
    };
    expect(inserted.id).toMatch(UUID_PATTERN);
    expect(supabase.questions[3].delete).toHaveBeenCalledOnce();
    expect(supabase.questions[3].eq).toHaveBeenCalledWith('id', inserted.id);
  });

  it('sanitizes the display file name before inserting', async () => {
    const supabase = createSupabaseMock([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(ensureSession).mockResolvedValue({
      sessionId: SESSION_ID,
      isNew: false,
    });

    const response = await POST(
      postRequest({
        fileName: 'folder/Peraturan\u0000 Perusahaan.pdf',
        fileSize: 1_024,
      }),
    );

    expect(response.status).toBe(201);
    expect(supabase.questions[2].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        file_name: 'folderPeraturan Perusahaan.pdf',
      }),
    );
  });

  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const request = new NextRequest('http://localhost:3000/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Data permintaan tidak valid.',
      },
    });
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it('returns RATE_LIMITED without creating a session or document', async () => {
    const supabase = createSupabaseMock([]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(enforceRateLimit).mockRejectedValue(
      new AppError(
        'RATE_LIMITED',
        429,
        'Terlalu banyak permintaan. Coba lagi dalam 30 detik.',
        30,
      ),
    );

    const response = await POST(
      postRequest({ fileName: 'baru.pdf', fileSize: 1_024 }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RATE_LIMITED', retryAfter: 30 },
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin mutation before touching the database', async () => {
    const response = await POST(
      postRequest(
        { fileName: 'baru.pdf', fileSize: 1_024 },
        { origin: 'https://evil.example' },
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(getServiceClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/documents', () => {
  it('returns an empty list without creating a session when there is no cookie', async () => {
    vi.mocked(readSessionId).mockReturnValue(null);

    const response = await GET(
      new NextRequest('http://localhost:3000/api/documents'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ documents: [] });
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it('lists active documents newest first with the shared item shape', async () => {
    const supabase = createSupabaseMock([
      {
        data: [
          documentRow({ chunk_count: 42 }),
          documentRow({
            id: '11111111-1111-4111-8111-111111111111',
            file_name: 'Laporan.pdf',
            status: 'embedding',
            chunk_count: 0,
          }),
        ],
        error: null,
      },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(
      new NextRequest('http://localhost:3000/api/documents'),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      documents: Array<Record<string, unknown>>;
    };

    expect(body.documents).toEqual([
      {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        fileName: 'Peraturan Perusahaan.pdf',
        fileSize: 1_024,
        pageCount: 12,
        status: 'ready',
        expiresAt: '2026-11-23T11:00:00Z',
        embeddedChunks: 0,
        totalChunks: 42,
      },
      {
        id: '11111111-1111-4111-8111-111111111111',
        fileName: 'Laporan.pdf',
        fileSize: 1_024,
        pageCount: 12,
        status: 'embedding',
        expiresAt: '2026-11-23T11:00:00Z',
        embeddedChunks: 0,
        totalChunks: 0,
      },
    ]);

    expect(supabase.questions[0].select).toHaveBeenCalledWith('*');
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.questions[0].gt).toHaveBeenCalledWith(
      'expires_at',
      NOW.toISOString(),
    );
    expect(supabase.questions[0].order).toHaveBeenCalledWith('created_at', {
      ascending: false,
    });
  });

  it('maps a list query error to INTERNAL_ERROR', async () => {
    const supabase = createSupabaseMock([
      { data: null, error: { message: 'database unavailable' } },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(
      new NextRequest('http://localhost:3000/api/documents'),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});
