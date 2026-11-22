// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import {
  chunkPages,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  pdfTooManyChunksMessage,
} from '@/lib/chunk';

function longText(label: string, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, index) =>
      `${label} kalimat ${index} memuat token unik ${label.toLowerCase()}-${index}.`,
  ).join(' ');
}

function commonOverlapLength(previous: string, next: string): number {
  for (let length = Math.min(previous.length, next.length); length > 0; length--) {
    if (previous.slice(-length) === next.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

async function expectAppError(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }

  throw new Error(`Expected AppError with code ${code}.`);
}

describe('chunkPages', () => {
  it('splits a long page into multiple chunks that all keep its page number', async () => {
    const chunks = await chunkPages(
      [{ pageNumber: 7, text: longText('PANJANG', 100) }],
      { maxChunks: 300 },
    );

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.pageNumber).toBe(7);
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    }
  });

  it('keeps a short page as exactly one chunk', async () => {
    const chunks = await chunkPages(
      [{ pageNumber: 14, text: '3 hari kerja' }],
      { maxChunks: 300 },
    );

    expect(chunks).toEqual([
      { pageNumber: 14, chunkIndex: 0, content: '3 hari kerja' },
    ]);
  });

  it('skips empty and whitespace-only pages without reserving indices', async () => {
    const chunks = await chunkPages(
      [
        { pageNumber: 1, text: 'Halaman pertama.' },
        { pageNumber: 2, text: '' },
        { pageNumber: 3, text: '   \n\t  ' },
        { pageNumber: 4, text: 'Halaman keempat.' },
      ],
      { maxChunks: 300 },
    );

    expect(chunks).toEqual([
      { pageNumber: 1, chunkIndex: 0, content: 'Halaman pertama.' },
      { pageNumber: 4, chunkIndex: 1, content: 'Halaman keempat.' },
    ]);
  });

  it('never puts text from two pages in the same chunk', async () => {
    const chunks = await chunkPages(
      [
        { pageNumber: 3, text: longText('ALPHA_MARKER', 120) },
        { pageNumber: 8, text: longText('OMEGA_MARKER', 120) },
      ],
      { maxChunks: 300 },
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.some((chunk) => chunk.pageNumber === 3)).toBe(true);
    expect(chunks.some((chunk) => chunk.pageNumber === 8)).toBe(true);

    for (const chunk of chunks) {
      const hasAlpha = chunk.content.includes('ALPHA_MARKER');
      const hasOmega = chunk.content.includes('OMEGA_MARKER');

      expect(hasAlpha && hasOmega).toBe(false);

      if (chunk.pageNumber === 3) {
        expect(hasAlpha).toBe(true);
        expect(hasOmega).toBe(false);
      } else {
        expect(chunk.pageNumber).toBe(8);
        expect(hasOmega).toBe(true);
        expect(hasAlpha).toBe(false);
      }
    }
  });

  it('assigns sequential chunk indices across pages starting at zero', async () => {
    const chunks = await chunkPages(
      [
        { pageNumber: 1, text: longText('SATU', 100) },
        { pageNumber: 2, text: 'Halaman pendek.' },
        { pageNumber: 3, text: longText('TIGA', 100) },
      ],
      { maxChunks: 300 },
    );

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );

    const pageNumbers = chunks.map((chunk) => chunk.pageNumber);
    expect(new Set(pageNumbers)).toEqual(new Set([1, 2, 3]));
    expect(pageNumbers).toEqual([...pageNumbers].sort((a, b) => a - b));
  });

  it('overlaps adjacent chunks on the same page', async () => {
    const chunks = await chunkPages(
      [{ pageNumber: 1, text: longText('OVERLAP', 12) }],
      { maxChunks: 300, chunkSize: 200, chunkOverlap: 80 },
    );

    expect(chunks.length).toBeGreaterThan(1);

    for (let index = 1; index < chunks.length; index++) {
      const overlap = commonOverlapLength(
        chunks[index - 1].content,
        chunks[index].content,
      );

      expect(overlap).toBeGreaterThanOrEqual(40);
    }
  });

  it('uses the default size and overlap for long pages', async () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(3000);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(300);

    const text = longText('DEFAULT', 100);
    const chunks = await chunkPages([{ pageNumber: 1, text }], {
      maxChunks: 300,
    });

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    }

    for (let index = 1; index < chunks.length; index++) {
      expect(
        commonOverlapLength(chunks[index - 1].content, chunks[index].content),
      ).toBeGreaterThan(0);
    }
  });

  it('allows exactly maxChunks chunks', async () => {
    const pages = [{ pageNumber: 1, text: longText('BATAS', 20) }];
    const allChunks = await chunkPages(pages, {
      maxChunks: 300,
      chunkSize: 100,
      chunkOverlap: 20,
    });

    expect(allChunks.length).toBeGreaterThan(1);

    const chunks = await chunkPages(pages, {
      maxChunks: allChunks.length,
      chunkSize: 100,
      chunkOverlap: 20,
    });

    expect(chunks).toHaveLength(allChunks.length);
    expect(chunks.map((chunk) => chunk.content)).toEqual(
      allChunks.map((chunk) => chunk.content),
    );
  });

  it('rejects a document with more than maxChunks chunks', async () => {
    const error = await expectAppError(
      chunkPages([{ pageNumber: 1, text: longText('LEBIH', 20) }], {
        maxChunks: 2,
        chunkSize: 100,
        chunkOverlap: 20,
      }),
      'PDF_TOO_MANY_CHUNKS',
    );

    expect(error.status).toBe(422);
    expect(error.message).toBe(pdfTooManyChunksMessage(2));
    expect(error.message).toBe(
      'Dokumen menghasilkan lebih dari 2 chunk. Pecah PDF menjadi beberapa file.',
    );
  });

  it('returns no chunks for an empty document', async () => {
    expect(await chunkPages([], { maxChunks: 300 })).toEqual([]);
  });
});
