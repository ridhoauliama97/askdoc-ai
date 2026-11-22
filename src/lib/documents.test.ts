// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  buildStoragePath,
  countsAsActiveDocument,
  getActiveDocumentCount,
  getActiveStorageBytes,
  getChunkProgress,
  getDocumentForSession,
  isDocumentExpired,
  isPdfFileName,
  sanitizeFileName,
  toDocumentListItem,
} from '@/lib/documents';
import type { DocumentRow } from '@/lib/types';

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
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

function supabaseWith(
  results: QueryResult[],
): { client: SupabaseClient<Database>; from: ReturnType<typeof vi.fn>; questions: QueryBuilder[] } {
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
    status: 'ready',
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildStoragePath', () => {
  it('builds the bucket path from session and document ids', () => {
    expect(buildStoragePath('s', 'd')).toBe('s/d.pdf');
  });
});

describe('isPdfFileName', () => {
  it('accepts PDF extensions case-insensitively', () => {
    expect(isPdfFileName('PERATURAN.PDF')).toBe(true);
    expect(isPdfFileName('laporan.pdf')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isPdfFileName('notes.txt')).toBe(false);
    expect(isPdfFileName('pdf')).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('preserves a normal display name', () => {
    expect(sanitizeFileName('Laporan Keuangan 2026.pdf')).toBe(
      'Laporan Keuangan 2026.pdf',
    );
  });

  it('strips path separators and control characters', () => {
    expect(
      sanitizeFileName('folder/sub\\Laporan\u0000 Keuangan.pdf'),
    ).toBe('foldersubLaporan Keuangan.pdf');
  });

  it('collapses whitespace and trims the result', () => {
    expect(sanitizeFileName('  Laporan   Tahunan.pdf  ')).toBe(
      'Laporan Tahunan.pdf',
    );
  });
});

describe('countsAsActiveDocument', () => {
  const base = {
    created_at: '2026-11-22T11:30:00Z',
    expires_at: '2026-11-23T11:30:00Z',
  };

  it('never counts a failed document', () => {
    expect(countsAsActiveDocument({ ...base, status: 'failed' })).toBe(false);
  });

  it('does not count an awaiting_upload document older than one hour', () => {
    expect(
      countsAsActiveDocument({
        ...base,
        status: 'awaiting_upload',
        created_at: '2026-11-22T10:59:59Z',
      }),
    ).toBe(false);
  });

  it('counts a recent awaiting_upload document', () => {
    expect(countsAsActiveDocument({ ...base, status: 'awaiting_upload' })).toBe(
      true,
    );
  });

  it('counts a ready document', () => {
    expect(countsAsActiveDocument({ ...base, status: 'ready' })).toBe(true);
  });

  it('does not count an expired document', () => {
    expect(
      countsAsActiveDocument({
        ...base,
        status: 'ready',
        expires_at: '2026-11-22T11:59:59Z',
      }),
    ).toBe(false);
  });
});

describe('isDocumentExpired', () => {
  it('is true at or past expires_at and false before it', () => {
    expect(
      isDocumentExpired({ expires_at: '2026-11-22T11:59:59Z' }, NOW),
    ).toBe(true);
    expect(
      isDocumentExpired({ expires_at: '2026-11-22T12:00:00Z' }, NOW),
    ).toBe(true);
    expect(
      isDocumentExpired({ expires_at: '2026-11-22T12:00:01Z' }, NOW),
    ).toBe(false);
  });
});

describe('getActiveDocumentCount', () => {
  it('filters rows with the shared active-document definition', async () => {
    const supabase = supabaseWith([
      {
        data: [
          {
            status: 'ready',
            created_at: '2026-11-22T11:00:00Z',
            expires_at: '2026-11-23T11:00:00Z',
          },
          {
            status: 'failed',
            created_at: '2026-11-22T11:00:00Z',
            expires_at: '2026-11-23T11:00:00Z',
          },
          {
            status: 'awaiting_upload',
            created_at: '2026-11-22T10:00:00Z',
            expires_at: '2026-11-23T10:00:00Z',
          },
          {
            status: 'ready',
            created_at: '2026-11-22T11:00:00Z',
            expires_at: '2026-11-22T11:59:59Z',
          },
        ],
        error: null,
      },
    ]);

    const count = await getActiveDocumentCount(supabase.client, SESSION_ID);

    expect(count).toBe(1);
    expect(supabase.questions[0].select).toHaveBeenCalledWith(
      'status, created_at, expires_at',
    );
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.questions[0].gt).toHaveBeenCalledWith(
      'expires_at',
      NOW.toISOString(),
    );
  });

  it('maps query errors to INTERNAL_ERROR', async () => {
    const supabase = supabaseWith([
      { data: null, error: { message: 'database unavailable' } },
    ]);

    await expect(
      getActiveDocumentCount(supabase.client, SESSION_ID),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('getActiveStorageBytes', () => {
  it('sums the size of non-expired, non-failed documents', async () => {
    const supabase = supabaseWith([
      { data: [{ file_size: 1_024 }, { file_size: 2_048 }], error: null },
    ]);

    const bytes = await getActiveStorageBytes(supabase.client);

    expect(bytes).toBe(3_072);
    expect(supabase.questions[0].select).toHaveBeenCalledWith('file_size');
    expect(supabase.questions[0].gt).toHaveBeenCalledWith(
      'expires_at',
      NOW.toISOString(),
    );
    expect(supabase.questions[0].neq).toHaveBeenCalledWith('status', 'failed');
  });

  it('maps query errors to INTERNAL_ERROR', async () => {
    const supabase = supabaseWith([
      { data: null, error: { message: 'database unavailable' } },
    ]);

    await expect(
      getActiveStorageBytes(supabase.client),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('getDocumentForSession', () => {
  it('scopes the lookup to the document, session, and expiry', async () => {
    const row = documentRow();
    const supabase = supabaseWith([{ data: row, error: null }]);

    const document = await getDocumentForSession(
      supabase.client,
      DOCUMENT_ID,
      SESSION_ID,
    );

    expect(document).toEqual(row);
    expect(supabase.questions[0].select).toHaveBeenCalledWith('*');
    expect(supabase.questions[0].eq).toHaveBeenCalledWith('id', DOCUMENT_ID);
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'session_id',
      SESSION_ID,
    );
    expect(supabase.questions[0].gt).toHaveBeenCalledWith(
      'expires_at',
      NOW.toISOString(),
    );
    expect(supabase.questions[0].maybeSingle).toHaveBeenCalledOnce();
  });

  it('can include expired rows so callers can return DOC_EXPIRED', async () => {
    const expired = documentRow({ expires_at: '2026-11-22T11:59:59Z' });
    const supabase = supabaseWith([{ data: expired, error: null }]);

    const document = await getDocumentForSession(
      supabase.client,
      DOCUMENT_ID,
      SESSION_ID,
      { includeExpired: true },
    );

    expect(document).toEqual(expired);
    expect(supabase.questions[0].gt).not.toHaveBeenCalled();
    expect(supabase.questions[0].maybeSingle).toHaveBeenCalledOnce();
  });

  it('returns null when the document does not belong to the session', async () => {
    const supabase = supabaseWith([{ data: null, error: null }]);

    await expect(
      getDocumentForSession(supabase.client, DOCUMENT_ID, SESSION_ID),
    ).resolves.toBeNull();
  });

  it('maps query errors to INTERNAL_ERROR', async () => {
    const supabase = supabaseWith([
      { data: null, error: { message: 'database unavailable' } },
    ]);

    await expect(
      getDocumentForSession(supabase.client, DOCUMENT_ID, SESSION_ID),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('getChunkProgress', () => {
  it('counts embedded and total chunks', async () => {
    const supabase = supabaseWith([
      { data: null, error: null, count: 7 },
      { data: null, error: null, count: 12 },
    ]);

    const progress = await getChunkProgress(
      supabase.client,
      DOCUMENT_ID,
      documentRow(),
    );

    expect(progress).toEqual({ embeddedChunks: 7, totalChunks: 12 });
    expect(supabase.questions[0].eq).toHaveBeenCalledWith(
      'document_id',
      DOCUMENT_ID,
    );
    expect(supabase.questions[0].not).toHaveBeenCalledWith(
      'embedding',
      'is',
      null,
    );
    expect(supabase.questions[1].eq).toHaveBeenCalledWith(
      'document_id',
      DOCUMENT_ID,
    );
  });

  it('falls back to the stored chunk count when the total query is null', async () => {
    const supabase = supabaseWith([
      { data: null, error: null, count: 7 },
      { data: null, error: null, count: null },
    ]);

    const progress = await getChunkProgress(
      supabase.client,
      DOCUMENT_ID,
      documentRow({ chunk_count: 12 }),
    );

    expect(progress).toEqual({ embeddedChunks: 7, totalChunks: 12 });
  });

  it('maps count query errors to INTERNAL_ERROR', async () => {
    const supabase = supabaseWith([
      { data: null, error: { message: 'database unavailable' }, count: null },
      { data: null, error: null, count: 0 },
    ]);

    await expect(
      getChunkProgress(supabase.client, DOCUMENT_ID, documentRow()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('toDocumentListItem', () => {
  it('maps snake_case rows to the shared list shape', () => {
    expect(
      toDocumentListItem(documentRow(), {
        embeddedChunks: 7,
        totalChunks: 42,
      }),
    ).toEqual({
      id: DOCUMENT_ID,
      fileName: 'Peraturan Perusahaan.pdf',
      fileSize: 1_024,
      pageCount: 12,
      status: 'ready',
      expiresAt: '2026-11-23T11:00:00Z',
      embeddedChunks: 7,
      totalChunks: 42,
    });
  });

  it('defaults progress to zero embedded and the stored chunk count', () => {
    expect(toDocumentListItem(documentRow())).toMatchObject({
      embeddedChunks: 0,
      totalChunks: 42,
    });
  });
});
