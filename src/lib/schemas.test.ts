import { describe, expect, it } from 'vitest';
import {
  chatRequestSchema,
  createDocumentSchema,
  ragSourceSchema,
} from '@/lib/schemas';

const DOCUMENT_ID = '3f0c1d2e-4a5b-4c6d-8e9f-0123456789ab';

describe('createDocumentSchema', () => {
  it('accepts an uppercase .PDF file name', () => {
    expect(
      createDocumentSchema.parse({
        fileName: 'PERATURAN.PDF',
        fileSize: 1024,
      }),
    ).toEqual({ fileName: 'PERATURAN.PDF', fileSize: 1024 });
  });

  it('rejects a non-PDF file name', () => {
    expect(
      createDocumentSchema.safeParse({ fileName: 'notes.txt', fileSize: 1024 })
        .success,
    ).toBe(false);
  });

  it('rejects an empty file name, non-positive size, and fractional size', () => {
    expect(
      createDocumentSchema.safeParse({ fileName: '', fileSize: 1024 }).success,
    ).toBe(false);
    expect(
      createDocumentSchema.safeParse({ fileName: 'a.pdf', fileSize: 0 })
        .success,
    ).toBe(false);
    expect(
      createDocumentSchema.safeParse({ fileName: 'a.pdf', fileSize: 1.5 })
        .success,
    ).toBe(false);
  });
});

describe('chatRequestSchema', () => {
  it('rejects an empty messages array', () => {
    expect(
      chatRequestSchema.safeParse({ documentId: DOCUMENT_ID, messages: [] })
        .success,
    ).toBe(false);
  });

  it('accepts a document id with one user message', () => {
    const result = chatRequestSchema.safeParse({
      documentId: DOCUMENT_ID,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Berapa hari cuti tahunan?' }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID document id', () => {
    expect(
      chatRequestSchema.safeParse({
        documentId: 'document-1',
        messages: [
          { id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Halo' }] },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a text part without text', () => {
    expect(
      chatRequestSchema.safeParse({
        documentId: DOCUMENT_ID,
        messages: [
          { id: 'message-1', role: 'user', parts: [{ type: 'text' }] },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a step-start part before text', () => {
    const result = chatRequestSchema.safeParse({
      documentId: DOCUMENT_ID,
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          parts: [{ type: 'step-start' }, { type: 'text', text: 'jawaban' }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown part type', () => {
    expect(
      chatRequestSchema.safeParse({
        documentId: DOCUMENT_ID,
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            parts: [{ type: 'tool-call' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects data-sources with the old wrapped sources object', () => {
    expect(
      chatRequestSchema.safeParse({
        documentId: DOCUMENT_ID,
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            parts: [
              {
                type: 'data-sources',
                data: {
                  sources: [
                    {
                      chunkId: 12,
                      page: 4,
                      excerpt: 'Cuti menikah diberikan tiga hari kerja.',
                      similarity: 0.82,
                    },
                  ],
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects data-sources when data is not an array', () => {
    expect(
      chatRequestSchema.safeParse({
        documentId: DOCUMENT_ID,
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            parts: [{ type: 'data-sources', data: 'garbage' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a valid data-sources message', () => {
    const result = chatRequestSchema.safeParse({
      documentId: DOCUMENT_ID,
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          parts: [
            {
              type: 'data-sources',
              id: 'sources',
              data: [
                {
                  chunkId: 12,
                  page: 4,
                  excerpt: 'Cuti menikah diberikan tiga hari kerja.',
                  similarity: 0.82,
                },
              ],
            },
            { type: 'text', text: 'Cuti menikah tiga hari. [Halaman 4]' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe('ragSourceSchema', () => {
  it('accepts a valid source', () => {
    expect(
      ragSourceSchema.parse({
        chunkId: 12,
        page: 4,
        excerpt: 'Cuti menikah diberikan tiga hari kerja.',
        similarity: 0.82,
      }),
    ).toEqual({
      chunkId: 12,
      page: 4,
      excerpt: 'Cuti menikah diberikan tiga hari kerja.',
      similarity: 0.82,
    });
  });

  it('rejects an invalid chunk id, page, or similarity', () => {
    expect(
      ragSourceSchema.safeParse({
        chunkId: 0,
        page: 1,
        excerpt: 'x',
        similarity: 0.5,
      }).success,
    ).toBe(false);
    expect(
      ragSourceSchema.safeParse({
        chunkId: 1,
        page: 0,
        excerpt: 'x',
        similarity: 0.5,
      }).success,
    ).toBe(false);
    expect(
      ragSourceSchema.safeParse({
        chunkId: 1,
        page: 1,
        excerpt: 'x',
        similarity: 1.5,
      }).success,
    ).toBe(false);
  });

  it('rejects an excerpt longer than 300 characters', () => {
    expect(
      ragSourceSchema.safeParse({
        chunkId: 1,
        page: 1,
        excerpt: 'a'.repeat(301),
        similarity: 0.5,
      }).success,
    ).toBe(false);
  });
});
