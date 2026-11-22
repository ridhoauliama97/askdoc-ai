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
});

describe('ragSourceSchema', () => {
  it('accepts a valid source', () => {
    expect(
      ragSourceSchema.parse({
        page: 4,
        excerpt: 'Cuti menikah diberikan tiga hari kerja.',
        similarity: 0.82,
      }),
    ).toEqual({
      page: 4,
      excerpt: 'Cuti menikah diberikan tiga hari kerja.',
      similarity: 0.82,
    });
  });

  it('rejects an invalid page or similarity', () => {
    expect(
      ragSourceSchema.safeParse({ page: 0, excerpt: 'x', similarity: 0.5 })
        .success,
    ).toBe(false);
    expect(
      ragSourceSchema.safeParse({ page: 1, excerpt: 'x', similarity: 1.5 })
        .success,
    ).toBe(false);
  });
});
