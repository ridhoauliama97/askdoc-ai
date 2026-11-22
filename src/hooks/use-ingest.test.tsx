import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListItem } from '@/lib/types';
import {
  INGEST_POLL_INTERVAL_MS,
  getIngestErrorMessage,
  useIngest,
} from './use-ingest';

const DOCUMENT_ID = '0b0f8f3a-2a6a-4e5a-9d2a-4f6c1c2a9b7e';
const OTHER_DOCUMENT_ID = '5d1c7a2e-9b4f-4c8a-b6d3-1e2f3a4b5c6d';

const fetchMock = vi.fn();

type ProgressOptions = {
  status?: DocumentListItem['status'];
  pageCount?: number | null;
  totalChunks?: number;
  embeddedChunks?: number;
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function ingestProgress({
  status = 'embedding',
  pageCount = 12,
  totalChunks = 40,
  embeddedChunks = 0,
}: ProgressOptions = {}) {
  return jsonResponse({
    status,
    pageCount,
    totalChunks,
    embeddedChunks,
    remaining: Math.max(0, totalChunks - embeddedChunks),
  });
}

function documentPayload(overrides: Partial<DocumentListItem> = {}) {
  const document: DocumentListItem = {
    id: DOCUMENT_ID,
    fileName: 'dokumen.pdf',
    fileSize: 1024,
    pageCount: 12,
    status: 'embedding',
    expiresAt: '2026-11-23T12:00:00.000Z',
    embeddedChunks: 0,
    totalChunks: 40,
    ...overrides,
  };

  return jsonResponse({ document });
}

function apiError(code: string, status: number, retryAfter?: number) {
  return jsonResponse(
    { error: { code, message: 'Pesan dari server.', retryAfter } },
    status,
  );
}

function isIngestPost(input: unknown, init?: RequestInit) {
  return (
    String(input) === `/api/documents/${DOCUMENT_ID}/ingest` &&
    init?.method === 'POST'
  );
}

function isDocumentGet(input: unknown, init?: RequestInit) {
  return (
    String(input) === `/api/documents/${DOCUMENT_ID}` &&
    (init?.method ?? 'GET') === 'GET'
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useIngest', () => {
  it('stops the first (extraction) call at embedded 0, then loops embedding batches until ready', async () => {
    fetchMock
      .mockResolvedValueOnce(ingestProgress({ embeddedChunks: 0 }))
      .mockResolvedValueOnce(ingestProgress({ embeddedChunks: 16 }))
      .mockResolvedValueOnce(ingestProgress({ embeddedChunks: 32 }))
      .mockResolvedValueOnce(
        ingestProgress({ status: 'ready', embeddedChunks: 40 }),
      );

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      await result.current.start();
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/documents/${DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/documents/${DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.progress).toEqual({
      documentId: DOCUMENT_ID,
      status: 'ready',
      pageCount: 12,
      totalChunks: 40,
      embeddedChunks: 40,
      remaining: 0,
    });
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('stops on 429 AI_RATE_LIMITED, keeps progress, and resumes after the retry window', async () => {
    fetchMock
      .mockResolvedValueOnce(ingestProgress({ embeddedChunks: 0 }))
      .mockResolvedValueOnce(apiError('AI_RATE_LIMITED', 429, 17));

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      await result.current.start();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toEqual({
      documentId: DOCUMENT_ID,
      code: 'AI_RATE_LIMITED',
      message:
        'Layanan AI sedang sibuk. Progres tersimpan. Coba lagi dalam 17 detik.',
      retryAfter: 17,
      retryable: true,
    });
    expect(result.current.progress).toEqual({
      documentId: DOCUMENT_ID,
      status: 'embedding',
      pageCount: 12,
      totalChunks: 40,
      embeddedChunks: 0,
      remaining: 40,
    });

    fetchMock.mockResolvedValueOnce(
      ingestProgress({ status: 'ready', embeddedChunks: 40 }),
    );

    await act(async () => {
      await result.current.resume();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.progress?.status).toBe('ready');
    expect(result.current.progress?.embeddedChunks).toBe(40);
  });

  it('polls the document on 409 and only retries ingest once the lock clears', async () => {
    vi.useFakeTimers();

    let ingestCalls = 0;
    let documentCalls = 0;

    fetchMock.mockImplementation(async (input, init) => {
      if (isIngestPost(input, init)) {
        ingestCalls += 1;

        if (ingestCalls === 1) {
          return apiError('INGEST_BUSY', 409);
        }

        if (ingestCalls === 2) {
          return ingestProgress({ embeddedChunks: 32 });
        }

        return ingestProgress({ status: 'ready', embeddedChunks: 40 });
      }

      if (isDocumentGet(input, init)) {
        documentCalls += 1;

        if (documentCalls <= 2) {
          return documentPayload({ embeddedChunks: 0, totalChunks: 40 });
        }

        return documentPayload({ embeddedChunks: 16, totalChunks: 40 });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));
    let startPromise: Promise<void>;

    await act(async () => {
      startPromise = result.current.start();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(ingestCalls).toBe(1);
    expect(documentCalls).toBe(1);
    expect(result.current.progress?.embeddedChunks).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INGEST_POLL_INTERVAL_MS);
    });

    // The lock has not moved yet: poll again instead of hammering ingest.
    expect(documentCalls).toBe(2);
    expect(ingestCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INGEST_POLL_INTERVAL_MS);
    });
    await act(async () => {
      await startPromise!;
    });

    expect(documentCalls).toBe(3);
    expect(ingestCalls).toBe(3);
    expect(result.current.progress).toEqual({
      documentId: DOCUMENT_ID,
      status: 'ready',
      pageCount: 12,
      totalChunks: 40,
      embeddedChunks: 40,
      remaining: 0,
    });
  });

  it('stops polling and does not ingest when the other tab already finished', async () => {
    vi.useFakeTimers();

    fetchMock.mockImplementation(async (input, init) => {
      if (isIngestPost(input, init)) {
        return apiError('INGEST_BUSY', 409);
      }

      if (isDocumentGet(input, init)) {
        return documentPayload({
          status: 'ready',
          embeddedChunks: 40,
          totalChunks: 40,
        });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      await result.current.start();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toEqual({
      documentId: DOCUMENT_ID,
      status: 'ready',
      pageCount: 12,
      totalChunks: 40,
      embeddedChunks: 40,
      remaining: 0,
    });
  });

  it('ignores a second start while the first loop is still running', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;

    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));
    let firstStart: Promise<void>;

    act(() => {
      firstStart = result.current.start();
    });

    act(() => {
      void result.current.start();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst!(ingestProgress({ status: 'ready', embeddedChunks: 40 }));
      await firstStart!;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.progress?.status).toBe('ready');
  });

  it('queues a second start while the first loop runs and begins it after the first finishes', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let resolveSecond: ((response: Response) => void) | undefined;

    fetchMock.mockImplementation((input) => {
      const url = String(input);

      if (url === `/api/documents/${DOCUMENT_ID}/ingest`) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }

      if (url === `/api/documents/${OTHER_DOCUMENT_ID}/ingest`) {
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));
    let firstStart: Promise<void>;

    act(() => {
      firstStart = result.current.start();
    });

    act(() => {
      void result.current.start(OTHER_DOCUMENT_ID);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst!(ingestProgress({ status: 'ready', embeddedChunks: 40 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/documents/${OTHER_DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      resolveSecond!(
        ingestProgress({
          status: 'ready',
          totalChunks: 10,
          embeddedChunks: 10,
        }),
      );
      await firstStart!;
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress?.documentId).toBe(OTHER_DOCUMENT_ID);
    expect(result.current.progress?.status).toBe('ready');
  });

  it('resumes the document that failed instead of the current selection', async () => {
    let failedDocumentCalls = 0;

    fetchMock.mockImplementation(async (input, init) => {
      if (
        String(input) === `/api/documents/${DOCUMENT_ID}/ingest` &&
        init?.method === 'POST'
      ) {
        failedDocumentCalls += 1;

        if (failedDocumentCalls === 1) {
          return apiError('AI_RATE_LIMITED', 429, 5);
        }

        return ingestProgress({ status: 'ready', embeddedChunks: 40 });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const { result } = renderHook(() => useIngest(OTHER_DOCUMENT_ID));

    await act(async () => {
      await result.current.start(DOCUMENT_ID);
    });

    expect(result.current.error?.documentId).toBe(DOCUMENT_ID);

    await act(async () => {
      await result.current.resume();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/documents/${DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.progress?.documentId).toBe(DOCUMENT_ID);
    expect(result.current.progress?.status).toBe('ready');
  });

  it('clears the polling interval when unmounted', async () => {
    vi.useFakeTimers();

    fetchMock.mockImplementation(async (input, init) => {
      if (isIngestPost(input, init)) {
        return apiError('INGEST_BUSY', 409);
      }

      if (isDocumentGet(input, init)) {
        return documentPayload({ embeddedChunks: 0, totalChunks: 40 });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const { result, unmount } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      void result.current.start();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes the server error message when a PDF step fails', async () => {
    fetchMock.mockResolvedValueOnce(apiError('PDF_TOO_MANY_PAGES', 422));

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toMatchObject({
      code: 'PDF_TOO_MANY_PAGES',
      message: 'PDF memiliki lebih dari 100 halaman.',
      retryable: false,
    });
  });

  it('uses the current document for start and the failed document for resume', async () => {
    fetchMock.mockResolvedValueOnce(
      ingestProgress({ status: 'ready', embeddedChunks: 40 }),
    );

    const { result } = renderHook(() => useIngest(DOCUMENT_ID));

    await act(async () => {
      await result.current.start();
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/documents/${DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.progress?.documentId).toBe(DOCUMENT_ID);
  });

  it('starts an explicitly passed document instead of the currently selected one', async () => {
    fetchMock.mockResolvedValueOnce(
      ingestProgress({ status: 'ready', embeddedChunks: 40 }),
    );

    const { result } = renderHook(() => useIngest(OTHER_DOCUMENT_ID));

    await act(async () => {
      await result.current.start(DOCUMENT_ID);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/documents/${DOCUMENT_ID}/ingest`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.progress?.documentId).toBe(DOCUMENT_ID);
  });
});

describe('getIngestErrorMessage', () => {
  it.each<[string, string]>([
    [
      'PDF_NO_TEXT',
      'PDF ini tidak mengandung teks yang bisa dibaca (kemungkinan hasil scan). OCR belum didukung.',
    ],
    ['PDF_TOO_MANY_PAGES', 'PDF memiliki lebih dari 100 halaman.'],
    [
      'PDF_TOO_MANY_CHUNKS',
      'Dokumen menghasilkan lebih dari 300 chunk. Pecah PDF menjadi beberapa file.',
    ],
    ['PDF_INVALID', 'File bukan PDF yang valid.'],
    [
      'UPLOAD_NOT_FOUND',
      'Upload belum selesai. Minta URL upload baru lalu ulangi.',
    ],
    ['DOC_NOT_READY', 'Dokumen gagal diproses. Hapus lalu unggah ulang.'],
    [
      'AI_RATE_LIMITED',
      'Layanan AI sedang sibuk. Progres tersimpan.',
    ],
  ])('maps %s to a friendly Indonesian message', (code, expected) => {
    expect(getIngestErrorMessage(code)).toBe(expected);
  });

  it('includes the retry window for RATE_LIMITED', () => {
    expect(getIngestErrorMessage('RATE_LIMITED', 30)).toBe(
      'Terlalu banyak permintaan. Coba lagi dalam 30 detik.',
    );
  });
});
