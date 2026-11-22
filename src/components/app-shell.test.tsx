import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListItem } from '@/lib/types';
import { AppShell } from './app-shell';

const { useDocumentsMock } = vi.hoisted(() => ({
  useDocumentsMock: vi.fn(),
}));

vi.mock('@/hooks/use-documents', () => ({
  useDocuments: useDocumentsMock,
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

function hookState(
  overrides: Partial<{
    documents: DocumentListItem[];
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    uploadPdf: (file: File) => Promise<string | null>;
  }> = {},
) {
  return {
    documents: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    uploadPdf: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useDocumentsMock.mockReturnValue(hookState());
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
