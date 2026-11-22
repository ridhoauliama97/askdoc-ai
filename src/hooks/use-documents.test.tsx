import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListItem } from '@/lib/types';
import { MAX_PDF_BYTES } from '@/lib/upload';
import { useDocuments } from './use-documents';

const { toastError, uploadToSignedUrl } = vi.hoisted(() => ({
  toastError: vi.fn(),
  uploadToSignedUrl: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: toastError },
}));

vi.mock('@/lib/supabase/browser', () => ({
  getBrowserClient: () => ({
    storage: {
      from: () => ({ uploadToSignedUrl }),
    },
  }),
}));

const fetchMock = vi.fn();

const DOCUMENT_ID = '0b0f8f3a-2a6a-4e5a-9d2a-4f6c1c2a9b7e';

const CREATED_UPLOAD = {
  documentId: DOCUMENT_ID,
  signedUrl: 'https://storage.test/object/upload/sign/session/document.pdf',
  token: 'upload-token',
  path: 'session/document.pdf',
};

const uploadedDocument: DocumentListItem = {
  id: DOCUMENT_ID,
  fileName: 'dokumen.pdf',
  fileSize: 9,
  pageCount: null,
  status: 'awaiting_upload',
  expiresAt: '2026-11-23T12:00:00.000Z',
  embeddedChunks: 0,
  totalChunks: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function isDocumentsGet(input: unknown, init?: RequestInit) {
  return String(input) === '/api/documents' && (init?.method ?? 'GET') === 'GET';
}

function isDocumentsPost(input: unknown, init?: RequestInit) {
  return String(input) === '/api/documents' && init?.method === 'POST';
}

function isUploadUrlPost(input: unknown) {
  return String(input) === `/api/documents/${DOCUMENT_ID}/upload-url`;
}

function pdfFile() {
  return new File(['%PDF-1.7\n'], 'dokumen.pdf', {
    type: 'application/pdf',
  });
}

async function renderDocumentsHook() {
  const hook = renderHook(() => useDocuments());

  await waitFor(() => expect(hook.result.current.loading).toBe(false));

  return hook;
}

beforeEach(() => {
  fetchMock.mockReset();
  uploadToSignedUrl.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useDocuments', () => {
  it('loads the document list on mount', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [uploadedDocument] }));

    const { result } = await renderDocumentsHook();

    expect(result.current.documents).toEqual([uploadedDocument]);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('rejects a non-PDF file before calling fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [] }));
    const { result } = await renderDocumentsHook();
    fetchMock.mockClear();

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(
        new File(['halo'], 'catatan.txt', { type: 'text/plain' }),
      );
    });

    expect(returned).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('File harus berformat PDF.');
  });

  it('rejects a file larger than 15 MB before calling fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [] }));
    const { result } = await renderDocumentsHook();
    fetchMock.mockClear();

    const oversize = {
      name: 'besar.pdf',
      size: MAX_PDF_BYTES + 1,
    } as File;

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(oversize);
    });

    expect(returned).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Ukuran file melebihi 15 MB.');
  });

  it('creates the document, uploads to the signed URL, refreshes, and returns the id', async () => {
    const file = pdfFile();

    fetchMock.mockImplementation(async (input, init) => {
      if (isDocumentsGet(input, init)) {
        return jsonResponse({ documents: [uploadedDocument] });
      }

      if (isDocumentsPost(input, init)) {
        return jsonResponse(CREATED_UPLOAD, 201);
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    uploadToSignedUrl.mockResolvedValue({
      data: { path: CREATED_UPLOAD.path },
      error: null,
    });

    const { result } = await renderDocumentsHook();
    fetchMock.mockClear();

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(file);
    });

    expect(returned).toBe(DOCUMENT_ID);

    const [createCall, refreshCall] = fetchMock.mock.calls;
    expect(createCall[0]).toBe('/api/documents');
    expect(createCall[1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(createCall[1]?.body))).toEqual({
      fileName: 'dokumen.pdf',
      fileSize: file.size,
    });
    expect(refreshCall[0]).toBe('/api/documents');

    expect(uploadToSignedUrl).toHaveBeenCalledTimes(1);
    expect(uploadToSignedUrl).toHaveBeenCalledWith(
      CREATED_UPLOAD.path,
      CREATED_UPLOAD.token,
      file,
      { contentType: 'application/pdf' },
    );
    expect(result.current.documents).toEqual([uploadedDocument]);
    expect(result.current.error).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('requests a fresh upload URL and retries once when the upload fails', async () => {
    const file = pdfFile();
    const refreshedUpload = {
      signedUrl: 'https://storage.test/object/upload/sign/session/document.pdf?retry',
      token: 'retry-token',
      path: CREATED_UPLOAD.path,
    };

    fetchMock.mockImplementation(async (input, init) => {
      if (isDocumentsGet(input, init)) {
        return jsonResponse({ documents: [uploadedDocument] });
      }

      if (isDocumentsPost(input, init)) {
        return jsonResponse(CREATED_UPLOAD, 201);
      }

      if (isUploadUrlPost(input)) {
        expect(init?.method).toBe('POST');

        return jsonResponse(refreshedUpload);
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    uploadToSignedUrl
      .mockResolvedValueOnce({ data: null, error: { message: 'expired' } })
      .mockResolvedValueOnce({
        data: { path: CREATED_UPLOAD.path },
        error: null,
      });

    const { result } = await renderDocumentsHook();

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(file);
    });

    expect(returned).toBe(DOCUMENT_ID);
    expect(uploadToSignedUrl).toHaveBeenCalledTimes(2);
    expect(uploadToSignedUrl).toHaveBeenNthCalledWith(
      1,
      CREATED_UPLOAD.path,
      CREATED_UPLOAD.token,
      file,
      { contentType: 'application/pdf' },
    );
    expect(uploadToSignedUrl).toHaveBeenNthCalledWith(
      2,
      refreshedUpload.path,
      refreshedUpload.token,
      file,
      { contentType: 'application/pdf' },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/documents/${DOCUMENT_ID}/upload-url`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('keeps the pending card and shows an error when both uploads fail', async () => {
    const file = pdfFile();

    fetchMock.mockImplementation(async (input, init) => {
      if (isDocumentsGet(input, init)) {
        return jsonResponse({ documents: [uploadedDocument] });
      }

      if (isDocumentsPost(input, init)) {
        return jsonResponse(CREATED_UPLOAD, 201);
      }

      if (isUploadUrlPost(input)) {
        return jsonResponse({
          signedUrl: CREATED_UPLOAD.signedUrl,
          token: 'retry-token',
          path: CREATED_UPLOAD.path,
        });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    uploadToSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'storage rejected the file' },
    });

    const { result } = await renderDocumentsHook();

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(file);
    });

    expect(returned).toBeNull();
    expect(toastError).toHaveBeenCalledWith('Upload gagal. Coba lagi.');
    expect(result.current.documents).toEqual([uploadedDocument]);
  });

  it.each<[string, number, number | undefined, string]>([
    ['FILE_TOO_LARGE', 400, undefined, 'Ukuran file melebihi 15 MB.'],
    [
      'DOC_LIMIT_REACHED',
      409,
      undefined,
      'Maksimal 5 dokumen aktif. Hapus dokumen lama untuk mengunggah lagi.',
    ],
    [
      'GLOBAL_LIMIT_REACHED',
      429,
      undefined,
      'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
    ],
    [
      'RATE_LIMITED',
      429,
      30,
      'Terlalu banyak permintaan. Coba lagi dalam 30 detik.',
    ],
  ])('toasts the friendly message for %s', async (code, status, retryAfter, expected) => {
    fetchMock.mockImplementation(async (input, init) => {
      if (isDocumentsGet(input, init)) {
        return jsonResponse({ documents: [] });
      }

      if (isDocumentsPost(input, init)) {
        return jsonResponse(
          { error: { code, message: 'Pesan dari server.', retryAfter } },
          status,
        );
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const { result } = await renderDocumentsHook();

    let returned: string | null = null;

    await act(async () => {
      returned = await result.current.uploadPdf(pdfFile());
    });

    expect(returned).toBeNull();
    expect(toastError).toHaveBeenCalledWith(expected);
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it('applies live ingest progress to a document', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [uploadedDocument] }));

    const { result } = await renderDocumentsHook();

    act(() => {
      result.current.updateDocumentProgress(DOCUMENT_ID, {
        status: 'embedding',
        pageCount: 12,
        embeddedChunks: 32,
        totalChunks: 120,
      });
    });

    expect(result.current.documents[0]).toEqual({
      ...uploadedDocument,
      status: 'embedding',
      pageCount: 12,
      embeddedChunks: 32,
      totalChunks: 120,
    });
  });

  it('polls every 5 seconds while a document is parsing or embedding', async () => {
    vi.useFakeTimers();

    const parsingDocument: DocumentListItem = {
      ...uploadedDocument,
      status: 'parsing',
    };

    fetchMock.mockResolvedValue(jsonResponse({ documents: [parsingDocument] }));

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll when no document is processing', async () => {
    vi.useFakeTimers();

    fetchMock.mockResolvedValue(jsonResponse({ documents: [uploadedDocument] }));

    renderHook(() => useDocuments());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling once every document is ready', async () => {
    vi.useFakeTimers();

    let documents: DocumentListItem[] = [
      { ...uploadedDocument, status: 'parsing' },
    ];

    fetchMock.mockImplementation(async () => jsonResponse({ documents }));

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    documents = [uploadedDocument];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.documents).toEqual([uploadedDocument]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the polling interval on unmount', async () => {
    vi.useFakeTimers();

    fetchMock.mockResolvedValue(
      jsonResponse({
        documents: [{ ...uploadedDocument, status: 'embedding' }],
      }),
    );

    const { unmount } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
