import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './app-shell';

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
});
