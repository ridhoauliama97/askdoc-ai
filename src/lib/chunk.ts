import 'server-only';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { AppError } from '@/lib/errors';

export const DEFAULT_CHUNK_SIZE = 3000;
export const DEFAULT_CHUNK_OVERLAP = 300;
export const CHUNK_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

export type ChunkablePage = {
  pageNumber: number;
  text: string;
};

export type ChunkPagesOptions = {
  maxChunks: number;
  chunkSize?: number;
  chunkOverlap?: number;
};

export type DocumentChunk = {
  pageNumber: number;
  chunkIndex: number;
  content: string;
};

export function pdfTooManyChunksMessage(maxChunks: number): string {
  return `Dokumen menghasilkan lebih dari ${maxChunks} chunk. Pecah PDF menjadi beberapa file.`;
}

function tooManyChunksError(maxChunks: number): AppError {
  return new AppError(
    'PDF_TOO_MANY_CHUNKS',
    422,
    pdfTooManyChunksMessage(maxChunks),
  );
}

/**
 * Splits pages page-by-page so every chunk belongs to exactly one page.
 * Short pages are kept; only empty/whitespace chunks are skipped.
 */
export async function chunkPages(
  pages: ChunkablePage[],
  opts: ChunkPagesOptions,
): Promise<DocumentChunk[]> {
  const {
    maxChunks,
    chunkSize = DEFAULT_CHUNK_SIZE,
    chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  } = opts;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: CHUNK_SEPARATORS,
  });

  const chunks: DocumentChunk[] = [];

  for (const page of pages) {
    const pieces = await splitter.splitText(page.text);

    for (const piece of pieces) {
      const content = piece.trim();

      if (!content) {
        continue;
      }

      // Never truncate silently: the first chunk beyond the quota rejects the
      // whole document.
      if (chunks.length >= maxChunks) {
        throw tooManyChunksError(maxChunks);
      }

      chunks.push({
        pageNumber: page.pageNumber,
        chunkIndex: chunks.length,
        content,
      });
    }
  }

  return chunks;
}
