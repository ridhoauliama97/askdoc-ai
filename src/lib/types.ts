import type { UIMessage } from 'ai';
import type { Database } from '@/lib/database.types';

export type DocumentStatus =
  | 'awaiting_upload'
  | 'parsing'
  | 'embedding'
  | 'ready'
  | 'failed';

export type DocumentRow =
  Database['public']['Tables']['rag_documents']['Row'];

export type DocumentListItem = {
  id: string;
  fileName: string;
  fileSize: number;
  pageCount: number | null;
  status: DocumentStatus;
  expiresAt: string;
  embeddedChunks: number;
  totalChunks: number;
};

export type RagSource = {
  chunkId: number;
  page: number;
  excerpt: string;
  similarity: number;
};

export type RagUIDataTypes = { sources: RagSource[] };

export type RagUIMessage = UIMessage<never, RagUIDataTypes>;
