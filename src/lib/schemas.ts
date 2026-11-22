import type { UIMessagePart, UITools } from 'ai';
import { z } from 'zod';
import type { RagSource, RagUIDataTypes, RagUIMessage } from '@/lib/types';

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
  page: z.number().int().positive(),
  excerpt: z.string().min(1),
  similarity: z.number().min(0).max(1),
});

const uiMessagePartSchema = z.custom<
  UIMessagePart<RagUIDataTypes, UITools>
>((value) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0;
});

export const ragUIMessageSchema: z.ZodType<RagUIMessage> = z.object({
  id: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(uiMessagePartSchema).min(1),
});

export const chatRequestSchema = z.object({
  documentId: z.uuid(),
  messages: z.array(ragUIMessageSchema).min(1, 'Minimal satu pesan.'),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
