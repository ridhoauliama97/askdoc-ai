// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/documents/[id]/route';
import type { Database } from '@/lib/database.types';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';
import type { DocumentRow } from '@/lib/types';

vi.mock('@/lib/supabase/server', () => ({
  getServiceClient: vi.fn(),
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

function createSupabaseMock(results: QueryResult[]) {
  const questions: QueryBuilder[] = [];
  const queue = [...results];
  const from = vi.fn(() => {
    const builder = queryBuilder(queue.shift() ?? { data: null, error: null });
    questions.push(builder);
    return builder;
  });

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    from,
    questions,
  };
}

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: DOCUMENT_ID,
    session_id: SESSION_ID,
    file_name: 'Peraturan Perusahaan.pdf',
    file_size: 1_024,
    page_count: 12,
    chunk_count: 42,
    status: 'embedding',
    error_code: null,
    error_message: null,
    storage_path: `${SESSION_ID}/${DOCUMENT_ID}.pdf`,
    ingest_lock_until: null,
    created_at: '2026-11-22T11:00:00Z',
    updated_at: '2026-11-22T11:00:00Z',
    expires_at: '2026-11-23T11:00:00Z',
    ...overrides,
  };
}

function request() {
  return new NextRequest(
    `http://localhost:3000/api/documents/${DOCUMENT_ID}`,
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
});

describe('GET /api/documents/:id', () => {
  it('returns the document with embedded and total chunk progress for its owner', async () => {
    const supabase = createSupabaseMock([
      { data: documentRow(), error: null },
      { data: null, error: null, count: 18 },
      { data: null, error: null, count: 42 },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      document: {
        id: DOCUMENT_ID,
        fileName: 'Peraturan Perusahaan.pdf',
        fileSize: 1_024,
        pageCount: 12,
        status: 'embedding',
        expiresAt: '2026-11-23T11:00:00Z',
        embeddedChunks: 18,
        totalChunks: 42,
      },
    });

    expect(supabase.questions[0].select).toHaveBeenCalledWith('*');
    expect(supabase.questions[0].eq).toHaveBeenCalledWith('id', DOCUMENT_ID);
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.questions[0].gt).not.toHaveBeenCalled();
    expect(supabase.questions[1].not).toHaveBeenCalledWith(
      'embedding',
      'is',
      null,
    );
  });

  it('returns 410 DOC_EXPIRED for an expired document owned by the session', async () => {
    const supabase = createSupabaseMock([
      {
        data: documentRow({ expires_at: '2026-11-22T11:59:59Z' }),
        error: null,
      },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(request(), context());

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'DOC_EXPIRED',
        message: 'Dokumen sudah kedaluwarsa dan dihapus.',
      },
    });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('returns INTERNAL_ERROR when chunk progress cannot be read', async () => {
    const supabase = createSupabaseMock([
      { data: documentRow(), error: null },
      { data: null, error: { message: 'database unavailable' }, count: null },
      { data: null, error: null, count: 42 },
    ]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('returns 404 for a document owned by another session', async () => {
    const supabase = createSupabaseMock([{ data: null, error: null }]);
    vi.mocked(getServiceClient).mockReturnValue(supabase.client);
    vi.mocked(readSessionId).mockReturnValue(OTHER_SESSION_ID);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Dokumen tidak ditemukan.' },
    });
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      OTHER_SESSION_ID,
    );
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when there is no session cookie', async () => {
    vi.mocked(readSessionId).mockReturnValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed document id without querying', async () => {
    vi.mocked(readSessionId).mockReturnValue(SESSION_ID);

    const response = await GET(request(), context('not-a-uuid'));

    expect(response.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
  });
});
