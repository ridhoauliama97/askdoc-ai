// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as route from '@/app/api/documents/[id]/ingest/route';
import { POST } from '@/app/api/documents/[id]/ingest/route';
import type { Database } from '@/lib/database.types';
import { getDocumentForSession } from '@/lib/documents';
import { AppError } from '@/lib/errors';
import { createIngestDeps, runIngestStep } from '@/lib/ingest';
import type { IngestDeps } from '@/lib/ingest';
import { enforceGlobalQuota, enforceRateLimit } from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';
import type { DocumentRow } from '@/lib/types';

vi.mock('@/lib/supabase/server', () => ({
  getServiceClient: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    RATE_LIMIT_SALT: 'test-salt',
    GLOBAL_DAILY_INGEST_BATCHES: 1_000,
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
    readSessionId: vi.fn(),
  };
});

vi.mock('@/lib/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents')>();

  return {
    ...actual,
    getDocumentForSession: vi.fn(),
  };
});

vi.mock('@/lib/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingest')>();

  return {
    ...actual,
    createIngestDeps: vi.fn(() => ({})),
    runIngestStep: vi.fn(),
  };
});

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
const OTHER_SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DOCUMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STORAGE_PATH = `${SESSION_ID}/${DOCUMENT_ID}.pdf`;

const PROGRESS = {
  status: 'embedding',
  pageCount: 12,
  totalChunks: 3,
  embeddedChunks: 0,
  remaining: 3,
} as const;

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
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest(
    `http://localhost:3000/api/documents/${DOCUMENT_ID}/ingest`,
    {
      method: 'POST',
      headers,
    },
  );
}

function context(id: string = DOCUMENT_ID) {
  return { params: Promise.resolve({ id }) };
}

const supabase = {} as SupabaseClient<Database>;

beforeEach(() => {
  vi.mocked(getServiceClient).mockReturnValue(supabase);
  vi.mocked(readSessionId).mockReturnValue(SESSION_ID);
  vi.mocked(getDocumentForSession).mockResolvedValue(documentRow());
  vi.mocked(enforceRateLimit).mockResolvedValue(undefined);
  vi.mocked(enforceGlobalQuota).mockResolvedValue(undefined);
  vi.mocked(createIngestDeps).mockReturnValue({} as IngestDeps);
  vi.mocked(runIngestStep).mockResolvedValue({ ...PROGRESS });
});

describe('POST /api/documents/:id/ingest', () => {
  it('runs the ingest step and returns its progress', async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(PROGRESS);

    expect(enforceRateLimit).toHaveBeenCalledWith(
      supabase,
      'ingest:ip-hash',
      60,
      60,
    );
    expect(enforceGlobalQuota).toHaveBeenCalledWith(supabase, 'ingest', 1_000);
    expect(
      vi.mocked(getDocumentForSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(enforceGlobalQuota).mock.invocationCallOrder[0],
    );
    expect(getDocumentForSession).toHaveBeenCalledWith(
      supabase,
      DOCUMENT_ID,
      SESSION_ID,
      { includeExpired: true },
    );
    expect(createIngestDeps).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        RATE_LIMIT_SALT: 'test-salt',
        GLOBAL_DAILY_INGEST_BATCHES: 1_000,
      }),
    );
    expect(runIngestStep).toHaveBeenCalledWith(expect.anything(), {
      documentId: DOCUMENT_ID,
      sessionId: SESSION_ID,
    });
  });

  it('exports maxDuration but not the forbidden runtime config', () => {
    expect(route.maxDuration).toBe(60);
    expect('runtime' in route).toBe(false);
  });

  it('returns 404 for a document owned by another session', async () => {
    vi.mocked(readSessionId).mockReturnValue(OTHER_SESSION_ID);
    vi.mocked(getDocumentForSession).mockResolvedValue(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Dokumen tidak ditemukan.' },
    });
    expect(getDocumentForSession).toHaveBeenCalledWith(
      supabase,
      DOCUMENT_ID,
      OTHER_SESSION_ID,
      { includeExpired: true },
    );
    expect(runIngestStep).not.toHaveBeenCalled();
    expect(enforceGlobalQuota).not.toHaveBeenCalled();
  });

  it('returns 410 for an expired document the session owns', async () => {
    vi.mocked(getDocumentForSession).mockResolvedValue(
      documentRow({ expires_at: '2020-01-01T00:00:00.000Z' }),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DOC_EXPIRED' },
    });
    expect(runIngestStep).not.toHaveBeenCalled();
    expect(enforceGlobalQuota).not.toHaveBeenCalled();
  });

  it('returns progress for a ready document without charging the global quota', async () => {
    vi.mocked(getDocumentForSession).mockResolvedValue(
      documentRow({ status: 'ready', page_count: 12, chunk_count: 30 }),
    );
    vi.mocked(runIngestStep).mockResolvedValue({
      status: 'ready',
      pageCount: 12,
      totalChunks: 30,
      embeddedChunks: 30,
      remaining: 0,
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ready' });
    expect(runIngestStep).toHaveBeenCalled();
    expect(enforceGlobalQuota).not.toHaveBeenCalled();
  });

  it('returns 409 INGEST_BUSY when another tab holds the lock', async () => {
    vi.mocked(runIngestStep).mockRejectedValue(
      new AppError('INGEST_BUSY', 409, 'Proses sedang berjalan di tab lain.'),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INGEST_BUSY',
        message: 'Proses sedang berjalan di tab lain.',
      },
    });
  });

  it('returns 404 when there is no session cookie', async () => {
    vi.mocked(readSessionId).mockReturnValue(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(runIngestStep).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed document id', async () => {
    const response = await POST(request(), context('not-a-uuid'));

    expect(response.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it('rejects with RATE_LIMITED before looking up the document', async () => {
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
    expect(getDocumentForSession).not.toHaveBeenCalled();
    expect(runIngestStep).not.toHaveBeenCalled();
  });

  it('rejects with GLOBAL_LIMIT_REACHED when the daily quota is spent', async () => {
    vi.mocked(enforceGlobalQuota).mockRejectedValue(
      new AppError(
        'GLOBAL_LIMIT_REACHED',
        429,
        'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
        3_600,
      ),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'GLOBAL_LIMIT_REACHED', retryAfter: 3_600 },
    });
    expect(getDocumentForSession).toHaveBeenCalled();
    expect(runIngestStep).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin mutation before any work', async () => {
    const response = await POST(
      request({ origin: 'https://evil.example' }),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(getServiceClient).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(runIngestStep).not.toHaveBeenCalled();
  });
});
