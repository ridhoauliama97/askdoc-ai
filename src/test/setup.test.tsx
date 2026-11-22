import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

function Probe({ label }: { label: string }) {
  return <p>{label}</p>;
}

describe('test setup', () => {
  it('renders the first probe', () => {
    render(<Probe label="first render" />);

    expect(screen.getByText('first render')).toBeInTheDocument();
  });

  it('does not leak the previous render', () => {
    render(<Probe label="second render" />);

    expect(screen.getByText('second render')).toBeInTheDocument();
    expect(screen.queryByText('first render')).not.toBeInTheDocument();
    expect(document.body.querySelectorAll('p')).toHaveLength(1);
  });
});
