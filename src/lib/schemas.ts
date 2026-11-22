import { z } from 'zod';
import type { RagSource, RagUIMessage } from '@/lib/types';

const pdfFileNameSchema = z
  .string()
  .trim()
  .min(1, 'Nama file wajib diisi.')
  .max(255, 'Nama file terlalu panjang.')
  .refine((name) => name.toLowerCase().endsWith('.pdf'), {
    message: 'File harus berformat PDF.',
  });

export const createDocumentSchema = z.object({
  fileName: pdfFileNameSchema,
  fileSize: z.number().int().positive(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const ragSourceSchema: z.ZodType<RagSource> = z.object({
  chunkId: z.number().int().positive(),
  page: z.number().int().positive(),
  excerpt: z.string().min(1).max(300),
  similarity: z.number().min(0).max(1),
});

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
});

const dataSourcesPartSchema = z.object({
  type: z.literal('data-sources'),
  id: z.string().optional(),
  data: z.array(ragSourceSchema),
});

const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  dataSourcesPartSchema,
]);

export const ragUIMessageSchema: z.ZodType<RagUIMessage> = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  parts: z.array(messagePartSchema).min(1),
});

export const chatRequestSchema = z.object({
  documentId: z.string().uuid(),
  messages: z.array(ragUIMessageSchema).min(1, 'Minimal satu pesan.'),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
