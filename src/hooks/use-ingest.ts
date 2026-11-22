'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentListItem, DocumentStatus } from '@/lib/types';

export const INGEST_POLL_INTERVAL_MS = 2_000;

const MAX_LOCK_POLLS = 30;
const INGEST_GENERIC_MESSAGE = 'Gagal memproses dokumen. Coba lagi.';
const FAILED_DOCUMENT_MESSAGE =
  'Dokumen gagal diproses. Hapus lalu unggah ulang.';
const UPLOAD_NOT_FOUND_MESSAGE =
  'Upload belum selesai. Minta URL upload baru lalu ulangi.';
const RATE_LIMITED_MESSAGE = 'Terlalu banyak permintaan. Coba lagi sebentar lagi.';
const GLOBAL_LIMIT_MESSAGE =
  'Kuota demo hari ini sudah habis. Silakan kembali besok ya.';

const NON_RETRYABLE_CODES = new Set([
  'PDF_NO_TEXT',
  'PDF_TOO_MANY_PAGES',
  'PDF_TOO_MANY_CHUNKS',
  'PDF_INVALID',
  'UPLOAD_NOT_FOUND',
  'DOC_NOT_READY',
  'DOC_EXPIRED',
  'NOT_FOUND',
  'FORBIDDEN',
  'GLOBAL_LIMIT_REACHED',
  'FILE_TOO_LARGE',
]);

export type IngestProgress = {
  documentId: string;
  status: DocumentStatus;
  pageCount: number | null;
  totalChunks: number;
  embeddedChunks: number;
  remaining: number;
};

export type IngestError = {
  documentId: string;
  code: string;
  message: string;
  retryAfter?: number;
  retryable: boolean;
};

type IngestApiProgress = {
  status?: DocumentStatus;
  pageCount?: number | null;
  totalChunks?: number;
  embeddedChunks?: number;
  remaining?: number;
};

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    retryAfter?: number;
  };
};

type DocumentBody = {
  document?: DocumentListItem;
};

type StepResult =
  | { kind: 'progress'; progress: IngestProgress }
  | { kind: 'error'; error: IngestError };

type PollResult =
  | { kind: 'retry' }
  | { kind: 'ready' }
  | { kind: 'failed' }
  | { kind: 'stopped' };

export function getIngestErrorMessage(
  code: string | undefined,
  retryAfter?: number,
): string {
  switch (code) {
    case 'PDF_TOO_MANY_PAGES':
      return 'PDF memiliki lebih dari 100 halaman.';
    case 'PDF_TOO_MANY_CHUNKS':
      return 'Dokumen menghasilkan lebih dari 300 chunk. Pecah PDF menjadi beberapa file.';
    case 'PDF_NO_TEXT':
      return 'PDF ini tidak mengandung teks yang bisa dibaca (kemungkinan hasil scan). OCR belum didukung.';
    case 'PDF_INVALID':
      return 'File bukan PDF yang valid.';
    case 'UPLOAD_NOT_FOUND':
      return UPLOAD_NOT_FOUND_MESSAGE;
    case 'DOC_NOT_READY':
      return FAILED_DOCUMENT_MESSAGE;
    case 'AI_RATE_LIMITED':
      return retryAfter !== undefined
        ? `Layanan AI sedang sibuk. Progres tersimpan. Coba lagi dalam ${retryAfter} detik.`
        : 'Layanan AI sedang sibuk. Progres tersimpan.';
    case 'INGEST_BUSY':
      return 'Proses sedang berjalan di tab lain.';
    case 'RATE_LIMITED':
      return retryAfter
        ? `Terlalu banyak permintaan. Coba lagi dalam ${retryAfter} detik.`
        : RATE_LIMITED_MESSAGE;
    case 'GLOBAL_LIMIT_REACHED':
      return GLOBAL_LIMIT_MESSAGE;
    case 'DOC_EXPIRED':
      return 'Dokumen sudah kedaluwarsa dan dihapus.';
    case 'FILE_TOO_LARGE':
      return 'Ukuran file melebihi 15 MB.';
    case 'NOT_FOUND':
      return 'Dokumen tidak ditemukan.';
    case 'FORBIDDEN':
      return 'Permintaan tidak diizinkan.';
    default:
      return INGEST_GENERIC_MESSAGE;
  }
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function buildError(
  documentId: string,
  code: string | undefined,
  retryAfter?: number,
): IngestError {
  const normalizedCode = code ?? 'INTERNAL_ERROR';
  const error: IngestError = {
    documentId,
    code: normalizedCode,
    message: getIngestErrorMessage(normalizedCode, retryAfter),
    retryable: !NON_RETRYABLE_CODES.has(normalizedCode),
  };

  if (retryAfter !== undefined) {
    error.retryAfter = retryAfter;
  }

  return error;
}

function buildFailedDocumentError(documentId: string): IngestError {
  return {
    documentId,
    code: 'DOC_NOT_READY',
    message: FAILED_DOCUMENT_MESSAGE,
    retryable: false,
  };
}

function toProgress(
  documentId: string,
  input: IngestApiProgress,
): IngestProgress | null {
  if (!input.status) {
    return null;
  }

  const totalChunks =
    typeof input.totalChunks === 'number' && input.totalChunks >= 0
      ? input.totalChunks
      : 0;
  const embeddedChunks =
    typeof input.embeddedChunks === 'number' && input.embeddedChunks >= 0
      ? Math.min(input.embeddedChunks, totalChunks)
      : 0;
  const computedRemaining = Math.max(0, totalChunks - embeddedChunks);
  const remaining =
    typeof input.remaining === 'number' && input.remaining >= 0
      ? input.remaining
      : computedRemaining;

  return {
    documentId,
    status: input.status,
    pageCount: input.pageCount ?? null,
    totalChunks,
    embeddedChunks,
    remaining,
  };
}

function documentToProgress(document: DocumentListItem): IngestProgress | null {
  return toProgress(document.id, document);
}

async function fetchDocumentProgress(
  documentId: string,
): Promise<IngestProgress | null> {
  try {
    const response = await fetch(`/api/documents/${documentId}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    const body = await readJson<DocumentBody>(response);

    return body?.document ? documentToProgress(body.document) : null;
  } catch {
    return null;
  }
}

async function postIngestStep(documentId: string): Promise<StepResult> {
  try {
    const response = await fetch(`/api/documents/${documentId}/ingest`, {
      method: 'POST',
    });
    const body = await readJson<IngestApiProgress & ApiErrorBody>(response);

    if (!response.ok) {
      return {
        kind: 'error',
        error: buildError(
          documentId,
          body?.error?.code,
          body?.error?.retryAfter,
        ),
      };
    }

    const progress = body ? toProgress(documentId, body) : null;

    if (!progress) {
      return {
        kind: 'error',
        error: buildError(documentId, undefined),
      };
    }

    return { kind: 'progress', progress };
  } catch {
    return {
      kind: 'error',
      error: {
        documentId,
        code: 'NETWORK_ERROR',
        message: INGEST_GENERIC_MESSAGE,
        retryable: true,
      },
    };
  }
}

export function useIngest(documentId: string | null) {
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<IngestError | null>(null);

  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runningDocumentIdRef = useRef<string | null>(null);
  const queueRef = useRef<string[]>([]);
  const pollIntervalRef = useRef<number | null>(null);
  const pollResolveRef = useRef<((result: PollResult) => void) | null>(null);
  const lastDocumentIdRef = useRef<string | null>(null);

  const applyProgress = useCallback((next: IngestProgress) => {
    if (mountedRef.current) {
      setProgress(next);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      const resolve = pollResolveRef.current;
      pollResolveRef.current = null;
      resolve?.({ kind: 'stopped' });
      queueRef.current = [];
    };
  }, []);

  const waitForLockClear = useCallback(
    (id: string, snapshot: IngestProgress | null): Promise<PollResult> => {
      return new Promise((resolve) => {
        pollResolveRef.current = resolve;
        let polls = 0;
        let isFetching = false;

        const finish = (result: PollResult) => {
          if (pollIntervalRef.current !== null) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }

          const pendingResolve = pollResolveRef.current;
          pollResolveRef.current = null;
          pendingResolve?.(result);
        };

        const tick = async () => {
          if (isFetching) {
            return;
          }

          isFetching = true;
          polls += 1;

          const next = await fetchDocumentProgress(id);
          isFetching = false;

          if (!mountedRef.current) {
            return;
          }

          if (!next) {
            if (polls >= MAX_LOCK_POLLS) {
              finish({ kind: 'retry' });
            }

            return;
          }

          applyProgress(next);

          if (next.status === 'ready') {
            finish({ kind: 'ready' });
            return;
          }

          if (next.status === 'failed') {
            finish({ kind: 'failed' });
            return;
          }

          const lockLikelyCleared =
            !snapshot ||
            next.status !== snapshot.status ||
            next.embeddedChunks !== snapshot.embeddedChunks ||
            next.totalChunks !== snapshot.totalChunks;

          if (lockLikelyCleared || polls >= MAX_LOCK_POLLS) {
            finish({ kind: 'retry' });
          }
        };

        pollIntervalRef.current = window.setInterval(() => {
          void tick();
        }, INGEST_POLL_INTERVAL_MS);
      });
    },
    [applyProgress],
  );

  const runIngestLoop = useCallback(
    async (id: string) => {
      while (mountedRef.current) {
        const step = await postIngestStep(id);

        if (!mountedRef.current) {
          return;
        }

        if (step.kind === 'error') {
          if (step.error.code === 'INGEST_BUSY') {
            // Read once so polling compares against the current server
            // progress instead of retrying blindly while another tab works.
            const baseline = await fetchDocumentProgress(id);

            if (!mountedRef.current) {
              return;
            }

            if (baseline) {
              applyProgress(baseline);

              if (baseline.status === 'ready') {
                return;
              }

              if (baseline.status === 'failed') {
                setError(buildFailedDocumentError(id));
                return;
              }
            }

            const poll = await waitForLockClear(id, baseline);

            if (!mountedRef.current) {
              return;
            }

            if (poll.kind === 'retry') {
              continue;
            }

            if (poll.kind === 'failed') {
              setError(buildFailedDocumentError(id));
            }

            return;
          }

          setError(step.error);
          return;
        }

        applyProgress(step.progress);

        if (
          step.progress.status === 'ready' ||
          step.progress.remaining === 0
        ) {
          return;
        }

        if (step.progress.status === 'failed') {
          setError(buildFailedDocumentError(id));
          return;
        }
      }
    },
    [applyProgress, waitForLockClear],
  );

  const start = useCallback(
    async (targetId?: string) => {
      const id = targetId ?? documentId;

      if (!id) {
        return;
      }

      if (runningRef.current) {
        // Uploads can finish while another document is still ingesting.
        // Keep the single-loop guarantee, but do not drop the new document.
        if (
          id !== runningDocumentIdRef.current &&
          !queueRef.current.includes(id)
        ) {
          queueRef.current.push(id);
        }

        return;
      }

      runningRef.current = true;
      runningDocumentIdRef.current = id;
      let nextId: string | null = id;

      setIsRunning(true);

      try {
        while (nextId && mountedRef.current) {
          runningDocumentIdRef.current = nextId;
          lastDocumentIdRef.current = nextId;
          setError(null);

          await runIngestLoop(nextId);

          nextId = queueRef.current.shift() ?? null;
        }
      } finally {
        runningRef.current = false;
        runningDocumentIdRef.current = null;

        if (mountedRef.current) {
          setIsRunning(false);
        }
      }
    },
    [documentId, runIngestLoop],
  );

  const resume = useCallback(async () => {
    const id =
      error?.documentId ??
      progress?.documentId ??
      lastDocumentIdRef.current ??
      documentId;

    if (!id) {
      return;
    }

    await start(id);
  }, [documentId, error, progress, start]);

  return { progress, isRunning, error, start, resume };
}
