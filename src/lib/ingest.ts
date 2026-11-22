import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  chunkPages,
  type ChunkablePage,
  type DocumentChunk,
} from '@/lib/chunk';
import type { Database } from '@/lib/database.types';
import {
  STORAGE_BUCKET,
  getChunkProgress,
  getDocumentForSession,
} from '@/lib/documents';
import { embedDocumentChunks, toPgVector } from '@/lib/embeddings';
import type { AppEnv } from '@/lib/env';
import {
  AppError,
  INTERNAL_ERROR_MESSAGE,
  type ErrorCode,
} from '@/lib/errors';
import { extractPdfPages, type PdfExtractionResult } from '@/lib/pdf';
import type { DocumentRow, DocumentStatus } from '@/lib/types';

export const INGEST_LOCK_SECONDS = 60;

export const INGEST_LIMIT = 60;
export const INGEST_WINDOW_SECONDS = 60;

const NOT_FOUND_MESSAGE = 'Dokumen tidak ditemukan.';
const FAILED_DOCUMENT_MESSAGE =
  'Dokumen gagal diproses. Hapus lalu unggah ulang.';
const INGEST_BUSY_MESSAGE = 'Proses sedang berjalan di tab lain.';
const UPLOAD_NOT_FOUND_MESSAGE =
  'Upload belum selesai. Minta URL upload baru lalu ulangi.';

const PDF_FAILURE_CODES = new Set<ErrorCode>([
  'PDF_NO_TEXT',
  'PDF_TOO_MANY_PAGES',
  'PDF_TOO_MANY_CHUNKS',
  'PDF_INVALID',
]);

export type IngestProgress = {
  status: DocumentStatus;
  pageCount: number | null;
  totalChunks: number;
  embeddedChunks: number;
  remaining: number;
};

export type IngestChunk = {
  id: number;
  chunkIndex: number;
  content: string;
};

export type IngestDocumentUpdate = Partial<
  Pick<
    DocumentRow,
    | 'status'
    | 'error_code'
    | 'error_message'
    | 'file_size'
    | 'page_count'
    | 'chunk_count'
    | 'ingest_lock_until'
  >
>;

export type IngestEnvLimits = Pick<
  AppEnv,
  'INGEST_BATCH_SIZE' | 'MAX_PDF_PAGES' | 'MAX_CHUNKS_PER_DOC'
>;

export type IngestDeps = {
  getDocument: (
    documentId: string,
    sessionId: string,
  ) => Promise<DocumentRow | null>;
  acquireLock: (documentId: string) => Promise<boolean>;
  releaseLock: (documentId: string) => Promise<void>;
  downloadFile: (storagePath: string) => Promise<Uint8Array>;
  listChunks: (documentId: string) => Promise<{ id: number }[]>;
  insertChunks: (documentId: string, chunks: DocumentChunk[]) => Promise<void>;
  getNullEmbeddingChunks: (
    documentId: string,
    limit: number,
  ) => Promise<IngestChunk[]>;
  updateChunkEmbeddings: (
    documentId: string,
    updates: { id: number; embedding: string }[],
  ) => Promise<void>;
  updateDocument: (
    documentId: string,
    update: IngestDocumentUpdate,
  ) => Promise<void>;
  countChunks: (
    documentId: string,
  ) => Promise<{ totalChunks: number; embeddedChunks: number }>;
  env: IngestEnvLimits;
  extractPdfPages: (
    bytes: Uint8Array,
    opts: { maxPages: number },
  ) => Promise<PdfExtractionResult>;
  chunkPages: (
    pages: ChunkablePage[],
    opts: { maxChunks: number },
  ) => Promise<DocumentChunk[]>;
  embedDocumentChunks: (texts: string[]) => Promise<number[][]>;
};

function buildProgress(
  status: DocumentStatus,
  pageCount: number | null,
  counts: { totalChunks: number; embeddedChunks: number },
): IngestProgress {
  return {
    status,
    pageCount,
    totalChunks: counts.totalChunks,
    embeddedChunks: counts.embeddedChunks,
    remaining: Math.max(0, counts.totalChunks - counts.embeddedChunks),
  };
}

function isPdfFailure(error: unknown): error is AppError {
  return error instanceof AppError && PDF_FAILURE_CODES.has(error.code);
}

async function runExtractionStep(
  deps: IngestDeps,
  document: DocumentRow,
): Promise<IngestProgress> {
  const documentId = document.id;
  const existingChunks = await deps.listChunks(documentId);

  if (existingChunks.length > 0) {
    // The previous request inserted chunks but died before setting the status.
    // Skipping re-extraction keeps this resume path idempotent.
    const counts = await deps.countChunks(documentId);

    await deps.updateDocument(documentId, {
      status: 'embedding',
      chunk_count: counts.totalChunks,
      error_code: null,
      error_message: null,
    });

    return buildProgress('embedding', document.page_count, counts);
  }

  const bytes = await deps.downloadFile(document.storage_path);

  // The client-reported size is not authoritative; real bytes feed the
  // global storage cap and the per-session UI.
  await deps.updateDocument(documentId, {
    status: 'parsing',
    file_size: bytes.length,
    error_code: null,
    error_message: null,
  });

  try {
    const extraction = await deps.extractPdfPages(bytes, {
      maxPages: deps.env.MAX_PDF_PAGES,
    });
    const chunks = await deps.chunkPages(extraction.pages, {
      maxChunks: deps.env.MAX_CHUNKS_PER_DOC,
    });

    await deps.insertChunks(documentId, chunks);
    await deps.updateDocument(documentId, {
      status: 'embedding',
      page_count: extraction.totalPages,
      chunk_count: chunks.length,
    });

    const counts = await deps.countChunks(documentId);

    return buildProgress('embedding', extraction.totalPages, counts);
  } catch (error) {
    if (isPdfFailure(error)) {
      await deps.updateDocument(documentId, {
        status: 'failed',
        error_code: error.code,
        error_message: error.message,
      });
    }

    throw error;
  }
}

async function runEmbeddingStep(
  deps: IngestDeps,
  document: DocumentRow,
): Promise<IngestProgress> {
  const documentId = document.id;
  const batch = await deps.getNullEmbeddingChunks(
    documentId,
    deps.env.INGEST_BATCH_SIZE,
  );

  if (batch.length > 0) {
    const embeddings = await deps.embedDocumentChunks(
      batch.map((chunk) => chunk.content),
    );

    if (embeddings.length !== batch.length) {
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    await deps.updateChunkEmbeddings(
      documentId,
      batch.map((chunk, index) => ({
        id: chunk.id,
        embedding: toPgVector(embeddings[index]),
      })),
    );
  }

  const counts = await deps.countChunks(documentId);
  const remaining = Math.max(0, counts.totalChunks - counts.embeddedChunks);
  const status: DocumentStatus = remaining === 0 ? 'ready' : 'embedding';

  if (status === 'ready') {
    await deps.updateDocument(documentId, { status: 'ready' });
  }

  return buildProgress(status, document.page_count, counts);
}

/**
 * Runs one resumable ingest step: extraction on the first call, one embedding
 * batch per later call. The first call deliberately stops after inserting the
 * null-embedding chunks so a large PDF stays under the 60s route budget.
 */
export async function runIngestStep(
  deps: IngestDeps,
  input: { documentId: string; sessionId: string },
): Promise<IngestProgress> {
  const { documentId, sessionId } = input;
  const document = await deps.getDocument(documentId, sessionId);

  if (!document) {
    throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
  }

  const status = document.status as DocumentStatus;

  if (status === 'failed') {
    throw new AppError('DOC_NOT_READY', 409, FAILED_DOCUMENT_MESSAGE);
  }

  if (status === 'ready') {
    const counts = await deps.countChunks(documentId);

    return buildProgress('ready', document.page_count, counts);
  }

  const acquired = await deps.acquireLock(documentId);

  if (!acquired) {
    throw new AppError('INGEST_BUSY', 409, INGEST_BUSY_MESSAGE);
  }

  try {
    if (status === 'awaiting_upload' || status === 'parsing') {
      return await runExtractionStep(deps, document);
    }

    return await runEmbeddingStep(deps, document);
  } finally {
    await deps.releaseLock(documentId);
  }
}

function internalError(): AppError {
  return new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
}

/**
 * Production wiring for the ingest service. Every function is injectable so
 * the state machine above can be tested without Storage, Postgres, or Gemini.
 */
export function createIngestDeps(
  supabase: SupabaseClient<Database>,
  env: IngestEnvLimits,
): IngestDeps {
  return {
    getDocument: (documentId, sessionId) =>
      getDocumentForSession(supabase, documentId, sessionId),

    acquireLock: async (documentId) => {
      const now = new Date();
      const lockUntil = new Date(
        now.getTime() + INGEST_LOCK_SECONDS * 1_000,
      ).toISOString();

      const { data, error } = await supabase
        .from('rag_documents')
        .update({ ingest_lock_until: lockUntil })
        .eq('id', documentId)
        .or(`ingest_lock_until.is.null,ingest_lock_until.lt.${now.toISOString()}`)
        .select('id')
        .maybeSingle();

      if (error) {
        throw internalError();
      }

      return data !== null;
    },

    releaseLock: async (documentId) => {
      const { error } = await supabase
        .from('rag_documents')
        .update({ ingest_lock_until: null })
        .eq('id', documentId);

      if (error) {
        throw internalError();
      }
    },

    downloadFile: async (storagePath) => {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

      if (error || !data) {
        throw new AppError('UPLOAD_NOT_FOUND', 409, UPLOAD_NOT_FOUND_MESSAGE);
      }

      return new Uint8Array(await data.arrayBuffer());
    },

    listChunks: async (documentId) => {
      const { data, error } = await supabase
        .from('rag_chunks')
        .select('id')
        .eq('document_id', documentId)
        .limit(1);

      if (error) {
        throw internalError();
      }

      return data ?? [];
    },

    insertChunks: async (documentId, chunks) => {
      if (chunks.length === 0) {
        return;
      }

      const { error } = await supabase.from('rag_chunks').insert(
        chunks.map((chunk) => ({
          document_id: documentId,
          page_number: chunk.pageNumber,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          embedding: null,
        })),
      );

      if (error) {
        throw internalError();
      }
    },

    getNullEmbeddingChunks: async (documentId, limit) => {
      const { data, error } = await supabase
        .from('rag_chunks')
        .select('id, chunk_index, content')
        .eq('document_id', documentId)
        .is('embedding', null)
        .order('chunk_index', { ascending: true })
        .limit(limit);

      if (error) {
        throw internalError();
      }

      return (data ?? []).map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunk_index,
        content: chunk.content,
      }));
    },

    updateChunkEmbeddings: async (documentId, updates) => {
      const results = await Promise.all(
        updates.map((update) =>
          supabase
            .from('rag_chunks')
            .update({ embedding: update.embedding })
            .eq('id', update.id)
            .eq('document_id', documentId),
        ),
      );

      if (results.some((result) => result.error)) {
        throw internalError();
      }
    },

    updateDocument: async (documentId, update) => {
      const { error } = await supabase
        .from('rag_documents')
        .update(update)
        .eq('id', documentId);

      if (error) {
        throw internalError();
      }
    },

    countChunks: (documentId) =>
      getChunkProgress(supabase, documentId, { chunk_count: 0 }),

    env,
    extractPdfPages: (bytes, opts) => extractPdfPages(bytes, opts),
    chunkPages: (pages, opts) => chunkPages(pages, opts),
    embedDocumentChunks: (texts) => embedDocumentChunks(texts),
  };
}
