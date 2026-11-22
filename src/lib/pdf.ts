import 'server-only';
import { AppError } from '@/lib/errors';
import { extractText, getDocumentProxy } from 'unpdf';

export const DEFAULT_PDF_TIMEOUT_MS = 30_000;
export const MIN_MEANINGFUL_TEXT_CHARS = 10;

export const PDF_INVALID_MESSAGE = 'File bukan PDF yang valid.';
export const PDF_NO_TEXT_MESSAGE =
  'PDF ini tidak mengandung teks yang bisa dibaca (kemungkinan hasil scan). OCR belum didukung.';

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type PdfPage = {
  pageNumber: number;
  text: string;
};

export type PdfExtractionResult = {
  totalPages: number;
  pages: PdfPage[];
};

export type PdfExtractionOptions = {
  maxPages: number;
  timeoutMs?: number;
};

export function pdfTooManyPagesMessage(maxPages: number): string {
  return `PDF memiliki lebih dari ${maxPages} halaman.`;
}

function invalidPdfError(): AppError {
  return new AppError('PDF_INVALID', 422, PDF_INVALID_MESSAGE);
}

function tooManyPagesError(maxPages: number): AppError {
  return new AppError(
    'PDF_TOO_MANY_PAGES',
    422,
    pdfTooManyPagesMessage(maxPages),
  );
}

export function validatePdfMagicBytes(bytes: Uint8Array): void {
  if (bytes.length < PDF_MAGIC_BYTES.length) {
    throw invalidPdfError();
  }

  const hasMagicBytes = PDF_MAGIC_BYTES.every(
    (byte, index) => bytes[index] === byte,
  );

  if (!hasMagicBytes) {
    throw invalidPdfError();
  }
}

export function normalizePageText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasMeaningfulText(pages: string[]): boolean {
  let totalCharacters = 0;

  for (const page of pages) {
    totalCharacters += normalizePageText(page).length;

    if (totalCharacters >= MIN_MEANINGFUL_TEXT_CHARS) {
      return true;
    }
  }

  return false;
}

function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  createError: () => AppError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs);
  });

  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function cleanupPdf(pdf: Awaited<ReturnType<typeof getDocumentProxy>>) {
  try {
    await pdf.cleanup();
  } catch {
    // Cleanup is best-effort; the extraction result is already settled.
  }
}

export async function extractPdfPages(
  bytes: Uint8Array,
  opts: PdfExtractionOptions,
): Promise<PdfExtractionResult> {
  const { maxPages, timeoutMs = DEFAULT_PDF_TIMEOUT_MS } = opts;

  validatePdfMagicBytes(bytes);

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;

  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw invalidPdfError();
  }

  try {
    if (pdf.numPages < 1) {
      throw invalidPdfError();
    }

    // Fail before text extraction so a hostile page tree cannot fan out.
    if (pdf.numPages > maxPages) {
      throw tooManyPagesError(maxPages);
    }

    const extraction = await withTimeout(
      extractText(pdf, { mergePages: false }),
      timeoutMs,
      invalidPdfError,
    ).catch((error: unknown) => {
      if (error instanceof AppError) {
        throw error;
      }

      throw invalidPdfError();
    });

    if (extraction.totalPages > maxPages) {
      throw tooManyPagesError(maxPages);
    }

    if (
      extraction.totalPages !== pdf.numPages ||
      extraction.text.length !== extraction.totalPages
    ) {
      throw invalidPdfError();
    }

    const normalized = extraction.text.map(normalizePageText);

    if (!hasMeaningfulText(normalized)) {
      throw new AppError('PDF_NO_TEXT', 422, PDF_NO_TEXT_MESSAGE);
    }

    return {
      totalPages: extraction.totalPages,
      pages: normalized.map((text, index) => ({
        pageNumber: index + 1,
        text,
      })),
    };
  } finally {
    await cleanupPdf(pdf);
  }
}
