import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListItem } from '@/lib/types';
import { AppShell } from './app-shell';

const { useDocumentsMock, useIngestMock } = vi.hoisted(() => ({
  useDocumentsMock: vi.fn(),
  useIngestMock: vi.fn(),
}));

vi.mock('@/hooks/use-documents', () => ({
  useDocuments: useDocumentsMock,
}));

vi.mock('@/hooks/use-ingest', () => ({
  useIngest: useIngestMock,
}));

const document: DocumentListItem = {
  id: '0b0f8f3a-2a6a-4e5a-9d2a-4f6c1c2a9b7e',
  fileName: 'peraturan-perusahaan.pdf',
  fileSize: 2 * 1024 * 1024,
  pageCount: 12,
  status: 'ready',
  expiresAt: '2026-11-23T12:00:00.000Z',
  embeddedChunks: 30,
  totalChunks: 30,
};

type IngestErrorState = {
  documentId: string;
  code: string;
  message: string;
  retryAfter?: number;
  retryable: boolean;
};

function hookState(
  overrides: Partial<{
    documents: DocumentListItem[];
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    uploadPdf: (file: File) => Promise<string | null>;
    updateDocumentProgress: (
      id: string,
      progress: {
        status: DocumentListItem['status'];
        pageCount: number | null;
        embeddedChunks: number;
        totalChunks: number;
      },
    ) => void;
  }> = {},
) {
  return {
    documents: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    uploadPdf: vi.fn(),
    updateDocumentProgress: vi.fn(),
    ...overrides,
  };
}

function ingestState(
  overrides: Partial<{
    progress: {
      documentId: string;
      status: DocumentListItem['status'];
      pageCount: number | null;
      totalChunks: number;
      embeddedChunks: number;
      remaining: number;
    } | null;
    isRunning: boolean;
    error: IngestErrorState | null;
    start: (id?: string) => Promise<void>;
    resume: () => Promise<void>;
  }> = {},
) {
  return {
    progress: null,
    isRunning: false,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  useDocumentsMock.mockReturnValue(hookState());
  useIngestMock.mockReturnValue(ingestState());
});

describe('AppShell', () => {
  it('shows the sidebar empty state when there are no documents', () => {
    render(<AppShell />);

    expect(
      screen.getByText('Unggah PDF pertama Anda untuk mulai bertanya.'),
    ).toBeInTheDocument();
  });

  it('shows the chat empty state and the unselected header', () => {
    render(<AppShell />);

    expect(
      screen.getByText(
        'Pilih dokumen di kiri, lalu tanyakan apa saja tentang isinya.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Pilih dokumen' }),
    ).toBeInTheDocument();
  });

  it('shows the upload limits copy', () => {
    render(<AppShell />);

    expect(
      screen.getByText(
        'PDF maks. 15 MB, 100 halaman. Dokumen dihapus otomatis setelah 24 jam.',
      ),
    ).toBeInTheDocument();
  });

  it('opens the selected document in the chat header', () => {
    useDocumentsMock.mockReturnValue(hookState({ documents: [document] }));

    render(<AppShell />);

    fireEvent.click(screen.getByText('peraturan-perusahaan.pdf'));

    expect(
      screen.getByRole('heading', { name: 'peraturan-perusahaan.pdf' }),
    ).toBeInTheDocument();
  });

  it('selects a document after a successful upload', async () => {
    const uploadPdf = vi.fn().mockResolvedValue(document.id);

    useDocumentsMock.mockReturnValue(
      hookState({ documents: [document], uploadPdf }),
    );

    const { container } = render(<AppShell />);
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );

    fireEvent.change(input!, {
      target: {
        files: [
          new File(['%PDF-1.7'], 'peraturan-perusahaan.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'peraturan-perusahaan.pdf' }),
      ).toBeInTheDocument(),
    );

    expect(uploadPdf).toHaveBeenCalledTimes(1);
  });

  it('starts ingest with the new document id after a successful upload', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const uploadPdf = vi.fn().mockResolvedValue(document.id);

    useDocumentsMock.mockReturnValue(
      hookState({ documents: [document], uploadPdf }),
    );
    useIngestMock.mockReturnValue(ingestState({ start }));

    const { container } = render(<AppShell />);
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );

    fireEvent.change(input!, {
      target: {
        files: [
          new File(['%PDF-1.7'], 'peraturan-perusahaan.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });

    await waitFor(() => expect(start).toHaveBeenCalledWith(document.id));
  });

  it('shows a resume action for a processing document without auto-starting', () => {
    const start = vi.fn().mockResolvedValue(undefined);

    useDocumentsMock.mockReturnValue(
      hookState({
        documents: [
          {
            ...document,
            status: 'embedding',
            embeddedChunks: 32,
            totalChunks: 120,
          },
        ],
      }),
    );
    useIngestMock.mockReturnValue(ingestState({ start }));

    render(<AppShell />);

    expect(start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }));

    expect(start).toHaveBeenCalledWith(document.id);
  });

  it('shows the AI busy banner and resumes the failed document', () => {
    const resume = vi.fn().mockResolvedValue(undefined);

    useDocumentsMock.mockReturnValue(hookState({ documents: [document] }));
    useIngestMock.mockReturnValue(
      ingestState({
        resume,
        error: {
          documentId: document.id,
          code: 'AI_RATE_LIMITED',
          message: 'Layanan AI sedang sibuk. Progres tersimpan.',
          retryAfter: 20,
          retryable: true,
        },
      }),
    );

    render(<AppShell />);

    expect(
      screen.getByText('Layanan AI sedang sibuk. Progres tersimpan.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }));

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('applies ingest progress to the document list and refreshes when ready', () => {
    const updateDocumentProgress = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const progress = {
      documentId: document.id,
      status: 'embedding' as const,
      pageCount: 12,
      totalChunks: 120,
      embeddedChunks: 32,
      remaining: 88,
    };

    useDocumentsMock.mockReturnValue(
      hookState({
        documents: [{ ...document, status: 'embedding' }],
        updateDocumentProgress,
        refresh,
      }),
    );
    useIngestMock.mockReturnValue(ingestState({ progress }));

    const { rerender } = render(<AppShell />);

    expect(updateDocumentProgress).toHaveBeenCalledWith(document.id, progress);

    useIngestMock.mockReturnValue(
      ingestState({ progress: { ...progress, status: 'ready', remaining: 0 } }),
    );

    rerender(<AppShell />);

    expect(refresh).toHaveBeenCalled();
  });

  it('shows a load error with a retry action', () => {
    const refresh = vi.fn();

    useDocumentsMock.mockReturnValue(
      hookState({ error: 'Gagal memuat dokumen. Coba lagi.', refresh }),
    );

    render(<AppShell />);

    expect(
      screen.getByText('Gagal memuat dokumen. Coba lagi.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
