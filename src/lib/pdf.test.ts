// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText } from 'unpdf';
import { describe, expect, it, vi } from 'vitest';
import type { ErrorCode } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import {
  extractPdfPages,
  hasMeaningfulText,
  normalizePageText,
  PDF_INVALID_MESSAGE,
  PDF_NO_TEXT_MESSAGE,
  validatePdfMagicBytes,
} from '@/lib/pdf';

vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();

  return {
    ...actual,
    extractText: vi.fn(actual.extractText),
  };
});

const FIXTURE_PATH = fileURLToPath(
  new URL('../../scripts/fixtures/peraturan-perusahaan.pdf', import.meta.url),
);

async function readFixture(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(FIXTURE_PATH));
}

async function createPdf(pageTexts: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const text of pageTexts) {
    const page = pdf.addPage();

    if (text) {
      page.drawText(text, { x: 48, y: 720, size: 12, font });
    }
  }

  return new Uint8Array(await pdf.save());
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

function expectAppErrorSync(fn: () => void, code: ErrorCode): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }

  throw new Error(`Expected AppError with code ${code}.`);
}

describe('validatePdfMagicBytes', () => {
  it('accepts bytes that start with the %PDF- signature', () => {
    expect(() =>
      validatePdfMagicBytes(new TextEncoder().encode('%PDF-1.7\n...')),
    ).not.toThrow();
  });

  it('rejects plain text with PDF_INVALID', () => {
    const error = expectAppErrorSync(
      () => validatePdfMagicBytes(new TextEncoder().encode('bukan pdf')),
      'PDF_INVALID',
    );

    expect(error.message).toBe(PDF_INVALID_MESSAGE);
    expect(error.status).toBe(422);
  });
});

describe('normalizePageText', () => {
  it('collapses repeated whitespace and removes null characters', () => {
    expect(normalizePageText('  Halo\u0000   dunia\n\nini\tuji  ')).toBe(
      'Halo dunia ini uji',
    );
    expect(normalizePageText('\u0000\u0000')).toBe('');
  });
});

describe('hasMeaningfulText', () => {
  it('rejects whitespace-only pages and pages with too little text', () => {
    expect(hasMeaningfulText(['  ', 'ok'])).toBe(false);
    expect(hasMeaningfulText([])).toBe(false);
  });

  it('accepts a short page that contains an answer', () => {
    expect(hasMeaningfulText(['3 hari kerja'])).toBe(true);
  });
});

describe('extractPdfPages', () => {
  it('extracts all 12 fixture pages with 1-based page numbers', async () => {
    const result = await extractPdfPages(await readFixture(), {
      maxPages: 12,
    });

    expect(result.totalPages).toBe(12);
    expect(result.pages).toHaveLength(12);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);

    for (const page of result.pages) {
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text).not.toContain('\u0000');
      expect(page.text).not.toMatch(/\s{2,}/);
      expect(page.text).toContain(`Halaman ${page.pageNumber} dari 12`);
      expect(page.text).toContain('Dokumen fiktif — bukan peraturan nyata.');
    }
  });

  it('keeps the calibration clauses on their expected fixture pages', async () => {
    const { pages } = await extractPdfPages(await readFixture(), {
      maxPages: 12,
    });
    const textOf = (pageNumber: number) =>
      pages[pageNumber - 1]?.text.toLowerCase() ?? '';

    expect(textOf(1)).toContain('pt contoh sejahtera');
    expect(textOf(2)).toContain('08.00–17.00');
    expect(textOf(3)).toContain('cuti tahunan sebanyak 12 hari');
    expect(textOf(3)).toContain('setelah karyawan bekerja minimal 1 tahun');
    expect(textOf(3)).toContain('7 hari sebelum tanggal cuti');
    expect(textOf(4)).toContain('cuti menikah');
    expect(textOf(4)).toContain('3 hari');
    expect(textOf(4)).toContain('dibayar penuh');
    expect(textOf(5)).toContain('cuti melahirkan selama 90 hari');
    expect(textOf(6)).toContain('tanpa surat dokter diberikan paling lama 1 hari');
    expect(textOf(7)).toContain('tanggal 25');
    expect(textOf(8)).toContain('notice period');
    expect(textOf(8)).toContain('30 hari');
    expect(textOf(9)).toContain('terlambat');
  });

  it('does not contain answers for the not-found calibration cases', async () => {
    const { pages } = await extractPdfPages(await readFixture(), {
      maxPages: 12,
    });
    const documentText = pages.map((page) => page.text.toLowerCase()).join('\n');

    for (const term of [
      'mobil dinas',
      'anggaran pelatihan',
      'asuransi gigi',
      'tunjangan transportasi',
      'kerja remote',
      'cuti sakit tahunan',
    ]) {
      expect(documentText).not.toContain(term);
    }
  });

  it('rejects a PDF with more pages than maxPages before extracting text', async () => {
    const bytes = await createPdf(['Halaman satu.', 'Halaman dua.', 'Halaman tiga.']);
    vi.mocked(extractText).mockClear();

    const error = await expectAppError(
      extractPdfPages(bytes, { maxPages: 2 }),
      'PDF_TOO_MANY_PAGES',
    );

    expect(error.message).toBe('PDF memiliki lebih dari 2 halaman.');
    expect(extractText).not.toHaveBeenCalled();
  });

  it('throws PDF_NO_TEXT for a PDF with blank pages', async () => {
    const error = await expectAppError(
      extractPdfPages(await createPdf(['', '']), { maxPages: 10 }),
      'PDF_NO_TEXT',
    );

    expect(error.message).toBe(PDF_NO_TEXT_MESSAGE);
    expect(error.status).toBe(422);
  });

  it('rejects bytes that are not a PDF', async () => {
    const error = await expectAppError(
      extractPdfPages(new TextEncoder().encode('plain text'), {
        maxPages: 10,
      }),
      'PDF_INVALID',
    );

    expect(error.message).toBe(PDF_INVALID_MESSAGE);
  });

  it('turns a hung text extraction into PDF_INVALID', async () => {
    vi.mocked(extractText).mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );

    const error = await expectAppError(
      extractPdfPages(await readFixture(), {
        maxPages: 12,
        timeoutMs: 25,
      }),
      'PDF_INVALID',
    );

    expect(error.message).toBe(PDF_INVALID_MESSAGE);
  });
});
