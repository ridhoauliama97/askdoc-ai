import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadButton } from './upload-button';

function pdfFile() {
  return new File(['%PDF-1.7\n'], 'dokumen.pdf', {
    type: 'application/pdf',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UploadButton', () => {
  it('opens the file picker when clicked', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');

    render(<UploadButton onUpload={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards the file selected from the picker', () => {
    const onUpload = vi.fn();
    const { container } = render(<UploadButton onUpload={onUpload} />);
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );

    const file = pdfFile();

    fireEvent.change(input!, { target: { files: [file] } });

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith(file);
  });

  it('accepts a dropped PDF', () => {
    const onUpload = vi.fn();

    render(<UploadButton onUpload={onUpload} />);

    const file = pdfFile();

    fireEvent.drop(screen.getByRole('button', { name: 'Upload PDF' }), {
      dataTransfer: { files: [file] },
    });

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith(file);
  });

  it('shows the uploading label and ignores input while uploading', () => {
    const onUpload = vi.fn();

    render(<UploadButton onUpload={onUpload} isUploading />);

    const button = screen.getByRole('button', { name: 'Mengunggah…' });

    expect(button).toBeDisabled();

    fireEvent.drop(button, { dataTransfer: { files: [pdfFile()] } });

    expect(onUpload).not.toHaveBeenCalled();
  });

  it('does not open the picker while disabled', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');

    render(<UploadButton onUpload={vi.fn()} disabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));

    expect(clickSpy).not.toHaveBeenCalled();
  });
});
