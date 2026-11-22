import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge';
import type { DocumentStatus } from '@/lib/types';

describe('StatusBadge', () => {
  it.each<[DocumentStatus, string]>([
    ['awaiting_upload', 'Menunggu upload'],
    ['parsing', 'Memproses…'],
    ['embedding', 'Memproses…'],
    ['ready', 'Siap ditanya'],
    ['failed', 'Gagal'],
  ])('renders %s as "%s"', (status, label) => {
    render(<StatusBadge status={status} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
