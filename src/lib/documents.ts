import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { AppError, INTERNAL_ERROR_MESSAGE } from '@/lib/errors';
import type {
  DocumentListItem,
  DocumentRow,
  DocumentStatus,
} from '@/lib/types';

export const STORAGE_BUCKET = 'rag-documents';

export const SIGNED_UPLOAD_LIMIT = 10;
export const SIGNED_UPLOAD_WINDOW_SECONDS = 600;

export const AWAITING_UPLOAD_MAX_AGE_MS = 60 * 60 * 1_000;

export type ActiveDocumentCandidate = Pick<
  DocumentRow,
  'status' | 'created_at' | 'expires_at'
>;

export type ChunkProgress = {
  embeddedChunks: number;
  totalChunks: number;
};

export function isPdfFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith('.pdf');
}

/**
 * Keeps the name as close to what the user sees while removing characters
 * that could be used for path traversal or log/display injection.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildStoragePath(
  sessionId: string,
  documentId: string,
): string {
  return `${sessionId}/${documentId}.pdf`;
}

export function isDocumentExpired(
  doc: Pick<DocumentRow, 'expires_at'>,
  now: Date = new Date(),
): boolean {
  return new Date(doc.expires_at).getTime() <= now.getTime();
}

/**
 * Active documents for the per-session quota: not expired, not failed, and
 * awaiting_upload only while the row is younger than one hour.
 */
export function countsAsActiveDocument(
  doc: ActiveDocumentCandidate,
  now: Date = new Date(),
): boolean {
  if (doc.status === 'failed') {
    return false;
  }

  if (isDocumentExpired(doc, now)) {
    return false;
  }

  if (doc.status === 'awaiting_upload') {
    return (
      now.getTime() - new Date(doc.created_at).getTime() <
      AWAITING_UPLOAD_MAX_AGE_MS
    );
  }

  return true;
}

export async function getActiveDocumentCount(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<number> {
  const now = new Date();
  const { data, error } = await supabase
    .from('rag_documents')
    .select('status, created_at, expires_at')
    .eq('session_id', sessionId)
    .gt('expires_at', now.toISOString());

  if (error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return (data ?? []).filter((doc) => countsAsActiveDocument(doc, now)).length;
}

export async function getActiveStorageBytes(
  supabase: SupabaseClient<Database>,
): Promise<number> {
  const { data, error } = await supabase
    .from('rag_documents')
    .select('file_size')
    .gt('expires_at', new Date().toISOString())
    .neq('status', 'failed');

  if (error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return (data ?? []).reduce(
    (total, doc) => total + Number(doc.file_size),
    0,
  );
}

export async function getDocumentForSession(
  supabase: SupabaseClient<Database>,
  documentId: string,
  sessionId: string,
  options: { includeExpired?: boolean } = {},
): Promise<DocumentRow | null> {
  let query = supabase
    .from('rag_documents')
    .select('*')
    .eq('id', documentId)
    .eq('session_id', sessionId);

  if (!options.includeExpired) {
    query = query.gt('expires_at', new Date().toISOString());
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return data;
}

export async function getChunkProgress(
  supabase: SupabaseClient<Database>,
  documentId: string,
  document: Pick<DocumentRow, 'chunk_count'>,
): Promise<ChunkProgress> {
  const [embedded, total] = await Promise.all([
    supabase
      .from('rag_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', documentId)
      .not('embedding', 'is', null),
    supabase
      .from('rag_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', documentId),
  ]);

  if (embedded.error || total.error) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return {
    embeddedChunks: embedded.count ?? 0,
    totalChunks: total.count ?? document.chunk_count,
  };
}

export function toDocumentListItem(
  document: DocumentRow,
  progress?: ChunkProgress,
): DocumentListItem {
  return {
    id: document.id,
    fileName: document.file_name,
    fileSize: Number(document.file_size),
    pageCount: document.page_count,
    status: document.status as DocumentStatus,
    expiresAt: document.expires_at,
    embeddedChunks: progress?.embeddedChunks ?? 0,
    totalChunks: progress?.totalChunks ?? document.chunk_count,
  };
}
