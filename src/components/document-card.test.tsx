import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListItem } from '@/lib/types';
import { DocumentCard } from './document-card';

const document: DocumentListItem = {
  id: '4c0f9d2e-8b1a-4f7c-9d3e-2a6b8c0d1e2f',
  fileName: 'peraturan-perusahaan.pdf',
  fileSize: 2 * 1024 * 1024,
  pageCount: 12,
  status: 'ready',
  expiresAt: '2026-11-22T12:30:00.000Z',
  embeddedChunks: 30,
  totalChunks: 30,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('DocumentCard', () => {
  it('renders the file name, size, page count, and time left', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T10:00:00.000Z'));

    render(<DocumentCard document={document} />);

    expect(screen.getByText('peraturan-perusahaan.pdf')).toBeInTheDocument();
    expect(screen.getByText(/2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/12 halaman/)).toBeInTheDocument();
    expect(screen.getByText(/2 jam 30 menit/)).toBeInTheDocument();
  });

  it('omits the page count until it is known', () => {
    render(
      <DocumentCard
        document={{ ...document, pageCount: null, status: 'parsing' }}
      />,
    );

    expect(screen.queryByText(/halaman/)).not.toBeInTheDocument();
  });

  it('shows a note that processing will start after upload', () => {
    render(
      <DocumentCard document={{ ...document, status: 'awaiting_upload' }} />,
    );

    expect(
      screen.getByText('Pemrosesan akan dimulai sebentar lagi.'),
    ).toBeInTheDocument();
  });

  it('lowercases the countdown when less than a minute is left', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:29:30.000Z'));

    render(<DocumentCard document={document} />);

    expect(screen.getByText('Sisa kurang dari 1 menit')).toBeInTheDocument();
  });
});
