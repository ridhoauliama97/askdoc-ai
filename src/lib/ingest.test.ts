// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentChunk } from '@/lib/chunk';
import { pdfTooManyChunksMessage } from '@/lib/chunk';
import type { Database } from '@/lib/database.types';
import { toPgVector } from '@/lib/embeddings';
import { AppError } from '@/lib/errors';
import {
  createIngestDeps,
  runIngestStep,
  type IngestChunk,
  type IngestEnvLimits,
} from '@/lib/ingest';
import {
  PDF_INVALID_MESSAGE,
  PDF_NO_TEXT_MESSAGE,
  pdfTooManyPagesMessage,
} from '@/lib/pdf';
import type { DocumentRow } from '@/lib/types';

const SESSION_ID = '2f1c9b6e-3a4d-4f5e-8a7b-1c2d3e4f5a6b';
const DOCUMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STORAGE_PATH = `${SESSION_ID}/${DOCUMENT_ID}.pdf`;
const LOCK_TOKEN = '2026-11-22T12:01:00.000Z';

const ENV: IngestEnvLimits = {
  INGEST_BATCH_SIZE: 16,
  MAX_PDF_PAGES: 100,
  MAX_CHUNKS_PER_DOC: 300,
};

const PAGES = [
  { pageNumber: 1, text: 'Halaman satu' },
  { pageNumber: 2, text: 'Halaman dua' },
];

const CHUNKS: DocumentChunk[] = [
  { pageNumber: 1, chunkIndex: 0, content: 'Halaman satu' },
  { pageNumber: 1, chunkIndex: 1, content: 'Halaman satu lanjutan' },
  { pageNumber: 2, chunkIndex: 2, content: 'Halaman dua' },
];

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

function nullChunks(count: number, startId = 101): IngestChunk[] {
  return Array.from({ length: count }, (_, index) => {
    const id = startId + index;

    return {
      id,
      chunkIndex: index,
      content: `Null chunk ${id}`,
    };
  });
}

function createHarness() {
  const bytes = new Uint8Array(1_536);
  const mocks = {
    getDocument: vi.fn(
      async (): Promise<DocumentRow | null> => documentRow(),
    ),
    acquireLock: vi.fn(
      async (): Promise<string | null> => LOCK_TOKEN,
    ),
    releaseLock: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => bytes),
    listChunks: vi.fn(async () => [] as { id: number }[]),
    insertChunks: vi.fn(async () => undefined),
    getNullEmbeddingChunks: vi.fn(async () => [] as IngestChunk[]),
    updateChunkEmbeddings: vi.fn<
      (
        documentId: string,
        updates: { id: number; embedding: string }[],
      ) => Promise<void>
    >(async () => undefined),
    updateDocument: vi.fn(async () => undefined),
    countChunks: vi.fn(async () => ({ totalChunks: 0, embeddedChunks: 0 })),
    extractPdfPages: vi.fn(async () => ({
      totalPages: PAGES.length,
      pages: PAGES,
    })),
    chunkPages: vi.fn(async () => CHUNKS),
    embedDocumentChunks: vi.fn(async (texts: string[]) =>
      texts.map((_, index) => [index + 1, 0]),
    ),
  };

  return {
    bytes,
    mocks,
    deps: { ...mocks, env: ENV },
  };
}

function input() {
  return { documentId: DOCUMENT_ID, sessionId: SESSION_ID };
}

describe('runIngestStep', () => {
  it('extracts and stores chunks on the first call without embedding', async () => {
    const harness = createHarness();
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 3,
      embeddedChunks: 0,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toEqual({
      status: 'embedding',
      pageCount: 2,
      totalChunks: 3,
      embeddedChunks: 0,
      remaining: 3,
    });
    expect(harness.mocks.getDocument).toHaveBeenCalledWith(
      DOCUMENT_ID,
      SESSION_ID,
    );
    expect(harness.mocks.acquireLock).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.mocks.listChunks).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(harness.mocks.downloadFile).toHaveBeenCalledWith(STORAGE_PATH);
    expect(harness.mocks.extractPdfPages).toHaveBeenCalledWith(harness.bytes, {
      maxPages: 100,
    });
    expect(harness.mocks.chunkPages).toHaveBeenCalledWith(PAGES, {
      maxChunks: 300,
    });
    expect(harness.mocks.insertChunks).toHaveBeenCalledWith(
      DOCUMENT_ID,
      CHUNKS,
    );

    // The first call is extraction-only: embedding would blow the 60s budget.
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
    expect(harness.mocks.getNullEmbeddingChunks).not.toHaveBeenCalled();
    expect(harness.mocks.updateChunkEmbeddings).not.toHaveBeenCalled();

    // Real bytes, not the client-reported file_size of 1,024.
    expect(harness.mocks.updateDocument).toHaveBeenNthCalledWith(
      1,
      DOCUMENT_ID,
      {
        status: 'parsing',
        file_size: harness.bytes.length,
        error_code: null,
        error_message: null,
      },
    );
    expect(harness.mocks.countChunks).toHaveBeenCalledWith(DOCUMENT_ID, 3);
    expect(harness.mocks.updateDocument).toHaveBeenNthCalledWith(
      2,
      DOCUMENT_ID,
      {
        page_count: 2,
      },
    );
    expect(harness.mocks.updateDocument).toHaveBeenNthCalledWith(
      3,
      DOCUMENT_ID,
      {
        status: 'embedding',
        page_count: 2,
        chunk_count: 3,
      },
    );
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it('resumes embedding without downloading or extracting again', async () => {
    const harness = createHarness();
    const batch = nullChunks(16);
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({
        status: 'embedding',
        page_count: 2,
        chunk_count: 20,
      }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue(batch);
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 20,
      embeddedChunks: 16,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toEqual({
      status: 'embedding',
      pageCount: 2,
      totalChunks: 20,
      embeddedChunks: 16,
      remaining: 4,
    });
    expect(harness.mocks.downloadFile).not.toHaveBeenCalled();
    expect(harness.mocks.listChunks).not.toHaveBeenCalled();
    expect(harness.mocks.extractPdfPages).not.toHaveBeenCalled();
    expect(harness.mocks.chunkPages).not.toHaveBeenCalled();
    expect(harness.mocks.insertChunks).not.toHaveBeenCalled();
    expect(harness.mocks.getNullEmbeddingChunks).toHaveBeenCalledWith(
      DOCUMENT_ID,
      16,
    );
    expect(harness.mocks.embedDocumentChunks).toHaveBeenCalledWith(
      batch.map((chunk) => chunk.content),
    );
    expect(harness.mocks.updateChunkEmbeddings).toHaveBeenCalledWith(
      DOCUMENT_ID,
      batch.map((chunk, index) => ({
        id: chunk.id,
        embedding: toPgVector([index + 1, 0]),
      })),
    );
    expect(harness.mocks.countChunks).toHaveBeenCalledWith(DOCUMENT_ID, 20);
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it('embeds only the next null batch and marks the document ready when done', async () => {
    const harness = createHarness();
    const batch = nullChunks(4, 201);
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({
        status: 'embedding',
        page_count: 2,
        chunk_count: 20,
      }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue(batch);
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 20,
      embeddedChunks: 20,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toEqual({
      status: 'ready',
      pageCount: 2,
      totalChunks: 20,
      embeddedChunks: 20,
      remaining: 0,
    });
    expect(harness.mocks.embedDocumentChunks).toHaveBeenCalledWith(
      batch.map((chunk) => chunk.content),
    );
    expect(harness.mocks.updateChunkEmbeddings).toHaveBeenCalledTimes(1);
    const updates = harness.mocks.updateChunkEmbeddings.mock.calls[0][1];

    // Already embedded chunks are never part of the null batch.
    expect(updates.map((update) => update.id)).toEqual([201, 202, 203, 204]);
    expect(harness.mocks.updateDocument).toHaveBeenCalledWith(DOCUMENT_ID, {
      status: 'ready',
    });
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it('marks the document ready without embedding when no null chunks remain', async () => {
    const harness = createHarness();
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'embedding', page_count: 2, chunk_count: 20 }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue([]);
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 20,
      embeddedChunks: 20,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toEqual({
      status: 'ready',
      pageCount: 2,
      totalChunks: 20,
      embeddedChunks: 20,
      remaining: 0,
    });
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
    expect(harness.mocks.updateChunkEmbeddings).not.toHaveBeenCalled();
    expect(harness.mocks.updateDocument).toHaveBeenCalledWith(DOCUMENT_ID, {
      status: 'ready',
    });
  });

  it('returns progress idempotently for a ready document', async () => {
    const harness = createHarness();
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'ready', page_count: 12, chunk_count: 30 }),
    );
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 30,
      embeddedChunks: 30,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toEqual({
      status: 'ready',
      pageCount: 12,
      totalChunks: 30,
      embeddedChunks: 30,
      remaining: 0,
    });
    expect(harness.mocks.acquireLock).not.toHaveBeenCalled();
    expect(harness.mocks.downloadFile).not.toHaveBeenCalled();
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
    expect(harness.mocks.countChunks).toHaveBeenCalledWith(DOCUMENT_ID, 30);
    expect(harness.mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('rejects a failed document with DOC_NOT_READY', async () => {
    const harness = createHarness();
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({
        status: 'failed',
        error_code: 'PDF_NO_TEXT',
        error_message: PDF_NO_TEXT_MESSAGE,
      }),
    );

    await expect(runIngestStep(harness.deps, input())).rejects.toMatchObject({
      code: 'DOC_NOT_READY',
      status: 409,
    });
    expect(harness.mocks.acquireLock).not.toHaveBeenCalled();
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
  });

  it('rejects a missing document with NOT_FOUND', async () => {
    const harness = createHarness();
    harness.mocks.getDocument.mockResolvedValue(null);

    await expect(runIngestStep(harness.deps, input())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(harness.mocks.acquireLock).not.toHaveBeenCalled();
  });

  it('returns INGEST_BUSY when another request holds the lock', async () => {
    const harness = createHarness();
    harness.mocks.acquireLock.mockResolvedValue(null);

    await expect(runIngestStep(harness.deps, input())).rejects.toMatchObject({
      code: 'INGEST_BUSY',
      status: 409,
    });
    expect(harness.mocks.downloadFile).not.toHaveBeenCalled();
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
    // Never release a lock this request did not acquire.
    expect(harness.mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('returns UPLOAD_NOT_FOUND and releases the lock when Storage has no object', async () => {
    const harness = createHarness();
    const failure = new AppError(
      'UPLOAD_NOT_FOUND',
      409,
      'Upload belum selesai. Minta URL upload baru lalu ulangi.',
    );
    harness.mocks.downloadFile.mockRejectedValue(failure);

    await expect(runIngestStep(harness.deps, input())).rejects.toBe(failure);
    expect(harness.mocks.updateDocument).not.toHaveBeenCalled();
    expect(harness.mocks.extractPdfPages).not.toHaveBeenCalled();
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it.each([
    {
      code: 'PDF_NO_TEXT',
      message: PDF_NO_TEXT_MESSAGE,
      stage: 'extract',
    },
    {
      code: 'PDF_TOO_MANY_PAGES',
      message: pdfTooManyPagesMessage(100),
      stage: 'extract',
    },
    {
      code: 'PDF_INVALID',
      message: PDF_INVALID_MESSAGE,
      stage: 'extract',
    },
    {
      code: 'PDF_TOO_MANY_CHUNKS',
      message: pdfTooManyChunksMessage(300),
      stage: 'chunk',
    },
  ] as const)(
    'persists $code as a failed status and releases the lock',
    async ({ code, message, stage }) => {
      const harness = createHarness();
      const failure = new AppError(code, 422, message);

      if (stage === 'extract') {
        harness.mocks.extractPdfPages.mockRejectedValue(failure);
      } else {
        harness.mocks.chunkPages.mockRejectedValue(failure);
      }

      await expect(runIngestStep(harness.deps, input())).rejects.toBe(failure);
      expect(harness.mocks.updateDocument).toHaveBeenLastCalledWith(
        DOCUMENT_ID,
        {
          status: 'failed',
          error_code: code,
          error_message: message,
        },
      );
      expect(harness.mocks.insertChunks).not.toHaveBeenCalled();
      expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
        DOCUMENT_ID,
        LOCK_TOKEN,
      );
    },
  );

  it('keeps the embedding status and progress on AI_RATE_LIMITED', async () => {
    const harness = createHarness();
    const failure = new AppError(
      'AI_RATE_LIMITED',
      429,
      'Layanan AI sedang sibuk. Coba lagi sebentar lagi.',
      20,
    );
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'embedding', page_count: 2, chunk_count: 20 }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue(nullChunks(16));
    harness.mocks.embedDocumentChunks.mockRejectedValue(failure);

    await expect(runIngestStep(harness.deps, input())).rejects.toBe(failure);
    expect(harness.mocks.updateChunkEmbeddings).not.toHaveBeenCalled();
    expect(harness.mocks.updateDocument).not.toHaveBeenCalled();
    expect(harness.mocks.countChunks).not.toHaveBeenCalled();
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it('releases the lock when an unexpected error is thrown', async () => {
    const harness = createHarness();
    const failure = new Error('database unavailable');
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'embedding', page_count: 2, chunk_count: 20 }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue(nullChunks(4));
    harness.mocks.updateChunkEmbeddings.mockRejectedValue(failure);

    await expect(runIngestStep(harness.deps, input())).rejects.toBe(failure);
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });

  it('preserves the primary error when releasing the lock fails', async () => {
    const harness = createHarness();
    const failure = new AppError(
      'AI_RATE_LIMITED',
      429,
      'Layanan AI sedang sibuk. Coba lagi sebentar lagi.',
      20,
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'embedding', page_count: 2, chunk_count: 20 }),
    );
    harness.mocks.getNullEmbeddingChunks.mockResolvedValue(nullChunks(16));
    harness.mocks.embedDocumentChunks.mockRejectedValue(failure);
    harness.mocks.releaseLock.mockRejectedValue(new Error('update failed'));

    await expect(runIngestStep(harness.deps, input())).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalledWith('Failed to release ingest lock.', {
      documentId: DOCUMENT_ID,
    });
    expect(harness.mocks.updateDocument).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('repairs a chunk insert that finished before the status update', async () => {
    const harness = createHarness();
    harness.mocks.getDocument.mockResolvedValue(
      documentRow({ status: 'parsing', chunk_count: 3 }),
    );
    harness.mocks.listChunks.mockResolvedValue([{ id: 1 }]);
    harness.mocks.countChunks.mockResolvedValue({
      totalChunks: 3,
      embeddedChunks: 0,
    });

    const result = await runIngestStep(harness.deps, input());

    expect(result).toMatchObject({
      status: 'embedding',
      totalChunks: 3,
      embeddedChunks: 0,
      remaining: 3,
    });
    expect(harness.mocks.downloadFile).not.toHaveBeenCalled();
    expect(harness.mocks.extractPdfPages).not.toHaveBeenCalled();
    expect(harness.mocks.insertChunks).not.toHaveBeenCalled();
    expect(harness.mocks.embedDocumentChunks).not.toHaveBeenCalled();
    expect(harness.mocks.countChunks).toHaveBeenCalledWith(DOCUMENT_ID, 3);
    expect(harness.mocks.updateDocument).toHaveBeenCalledWith(DOCUMENT_ID, {
      status: 'embedding',
      chunk_count: 3,
      error_code: null,
      error_message: null,
    });
    expect(harness.mocks.releaseLock).toHaveBeenCalledWith(
      DOCUMENT_ID,
      LOCK_TOKEN,
    );
  });
});

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

type QueryBuilder = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
};

function queryBuilder(result: QueryResult): QueryBuilder {
  const builder = {} as QueryBuilder;

  for (const method of [
    'select',
    'eq',
    'is',
    'not',
    'order',
    'limit',
    'or',
  ] as const) {
    builder[method] = vi.fn(() => builder);
  }

  builder.insert = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = vi.fn(
    (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  );

  return builder;
}

function createSupabaseWith(
  fromResults: QueryResult[],
  downloadResult: QueryResult & { data?: Blob | null } = {
    data: new Blob(),
    error: null,
  },
) {
  const builders: QueryBuilder[] = [];
  const queue = [...fromResults];

  const from = vi.fn(() => {
    const builder = queryBuilder(queue.shift() ?? { data: null, error: null });
    builders.push(builder);
    return builder;
  });

  const download = vi.fn(async () => downloadResult);
  const storageFrom = vi.fn(() => ({ download }));

  return {
    client: {
      from,
      storage: { from: storageFrom },
    } as unknown as SupabaseClient<Database>,
    builders,
    from,
    storageFrom,
    download,
  };
}

type LockRow = {
  id: string;
  ingest_lock_until: string | null;
};

type LockBuilder = {
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
};

/**
 * Minimal in-memory rag_documents row so conditional updates behave like
 * PostgREST: a filter that does not match leaves the row untouched.
 */
function lockBuilder(store: LockRow): LockBuilder {
  const builder = {} as LockBuilder;
  let patch: { ingest_lock_until: string | null } | null = null;
  const filters: {
    column: 'id' | 'ingest_lock_until';
    value: string | null;
  }[] = [];

  const matches = () =>
    filters.every(({ column, value }) => store[column] === value);

  const apply = () => {
    if (!matches()) {
      return false;
    }

    if (patch) {
      store.ingest_lock_until = patch.ingest_lock_until;
    }

    return true;
  };

  builder.update = vi.fn((value: { ingest_lock_until: string | null }) => {
    patch = value;
    return builder;
  });
  builder.eq = vi.fn(
    (column: 'id' | 'ingest_lock_until', value: string | null) => {
      filters.push({ column, value });
      return builder;
    },
  );
  builder.or = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () =>
    apply()
      ? { data: { id: store.id }, error: null }
      : { data: null, error: null },
  );
  builder.then = vi.fn(
    (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => {
      const result = apply()
        ? { data: { id: store.id }, error: null }
        : { data: null, error: null };

      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  );

  return builder;
}

function createLockClient(store: LockRow) {
  const from = vi.fn(() => lockBuilder(store));

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    store,
    from,
  };
}

describe('createIngestDeps', () => {
  it('acquires the lock with a conditional update and returns its lease', async () => {
    const acquired = createSupabaseWith([{ data: { id: DOCUMENT_ID } }]);
    const deps = createIngestDeps(acquired.client, ENV);

    const token = await deps.acquireLock(DOCUMENT_ID);

    expect(token).toEqual(expect.any(String));
    expect(acquired.builders[0].update).toHaveBeenCalledWith({
      ingest_lock_until: token,
    });
    expect(acquired.builders[0].eq).toHaveBeenCalledWith('id', DOCUMENT_ID);
    expect(acquired.builders[0].or).toHaveBeenCalledWith(
      expect.stringContaining(
        'ingest_lock_until.is.null,ingest_lock_until.lt.',
      ),
    );
    expect(acquired.builders[0].select).toHaveBeenCalledWith('id');

    const busy = createSupabaseWith([{ data: null }]);
    const busyDeps = createIngestDeps(busy.client, ENV);

    await expect(busyDeps.acquireLock(DOCUMENT_ID)).resolves.toBeNull();
  });

  it('releases only the lease this request acquired', async () => {
    const store: LockRow = {
      id: DOCUMENT_ID,
      ingest_lock_until: 'fresh-lock-lease',
    };
    const lock = createLockClient(store);
    const deps = createIngestDeps(lock.client, ENV);

    // A late request whose 60s lease expired must not clear the new owner.
    await deps.releaseLock(DOCUMENT_ID, 'stale-lock-lease');
    expect(store.ingest_lock_until).toBe('fresh-lock-lease');

    await deps.releaseLock(DOCUMENT_ID, 'fresh-lock-lease');
    expect(store.ingest_lock_until).toBeNull();
  });

  it('falls back to the document chunk count when the count header is missing', async () => {
    const query = createSupabaseWith([
      { count: 0, data: null },
      { count: null, data: null },
    ]);
    const deps = createIngestDeps(query.client, ENV);

    await expect(deps.countChunks(DOCUMENT_ID, 7)).resolves.toEqual({
      embeddedChunks: 0,
      totalChunks: 7,
    });
  });

  it('downloads the object and maps a missing object to UPLOAD_NOT_FOUND', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    const found = createSupabaseWith([], {
      data: new Blob([bytes], { type: 'application/pdf' }),
      error: null,
    });
    const deps = createIngestDeps(found.client, ENV);

    await expect(deps.downloadFile(STORAGE_PATH)).resolves.toEqual(bytes);
    expect(found.storageFrom).toHaveBeenCalledWith('rag-documents');
    expect(found.download).toHaveBeenCalledWith(STORAGE_PATH);

    const missing = createSupabaseWith([], {
      data: null,
      error: { message: 'Object not found' },
    });
    const missingDeps = createIngestDeps(missing.client, ENV);

    await expect(missingDeps.downloadFile(STORAGE_PATH)).rejects.toMatchObject({
      code: 'UPLOAD_NOT_FOUND',
      status: 409,
    });
  });

  it('reads the next null-embedding batch ordered by chunk index', async () => {
    const query = createSupabaseWith([
      {
        data: [{ id: 5, chunk_index: 2, content: 'Isi chunk' }],
      },
    ]);
    const deps = createIngestDeps(query.client, ENV);

    await expect(deps.getNullEmbeddingChunks(DOCUMENT_ID, 16)).resolves.toEqual(
      [{ id: 5, chunkIndex: 2, content: 'Isi chunk' }],
    );
    expect(query.builders[0].eq).toHaveBeenCalledWith(
      'document_id',
      DOCUMENT_ID,
    );
    expect(query.builders[0].is).toHaveBeenCalledWith('embedding', null);
    expect(query.builders[0].order).toHaveBeenCalledWith('chunk_index', {
      ascending: true,
    });
    expect(query.builders[0].limit).toHaveBeenCalledWith(16);
  });

  it('inserts null-embedding chunks and scopes embedding updates by document', async () => {
    const insert = createSupabaseWith([{ data: null }]);
    const insertDeps = createIngestDeps(insert.client, ENV);

    await insertDeps.insertChunks(DOCUMENT_ID, CHUNKS);
    expect(insert.builders[0].insert).toHaveBeenCalledWith([
      {
        document_id: DOCUMENT_ID,
        page_number: 1,
        chunk_index: 0,
        content: 'Halaman satu',
        embedding: null,
      },
      {
        document_id: DOCUMENT_ID,
        page_number: 1,
        chunk_index: 1,
        content: 'Halaman satu lanjutan',
        embedding: null,
      },
      {
        document_id: DOCUMENT_ID,
        page_number: 2,
        chunk_index: 2,
        content: 'Halaman dua',
        embedding: null,
      },
    ]);

    const update = createSupabaseWith([{ data: null }]);
    const updateDeps = createIngestDeps(update.client, ENV);

    await updateDeps.updateChunkEmbeddings(DOCUMENT_ID, [
      { id: 7, embedding: '[0.1,0.2]' },
    ]);
    expect(update.builders[0].update).toHaveBeenCalledWith({
      embedding: '[0.1,0.2]',
    });
    expect(update.builders[0].eq).toHaveBeenCalledWith('id', 7);
    expect(update.builders[0].eq).toHaveBeenCalledWith(
      'document_id',
      DOCUMENT_ID,
    );
  });
});
