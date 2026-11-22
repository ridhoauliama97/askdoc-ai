'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getBrowserClient } from '@/lib/supabase/browser';
import type { DocumentListItem, DocumentStatus } from '@/lib/types';
import {
  DOCUMENTS_LOAD_MESSAGE,
  PDF_CONTENT_TYPE,
  UPLOAD_GENERIC_MESSAGE,
  UPLOAD_RETRY_FAILED_MESSAGE,
  getUploadErrorMessage,
  validatePdfFile,
  type ApiErrorPayload,
} from '@/lib/upload';

const DOCUMENTS_ENDPOINT = '/api/documents';
const STORAGE_BUCKET = 'rag-documents';

export const DOCUMENTS_POLL_INTERVAL_MS = 5_000;

type DocumentsResponse = {
  documents?: DocumentListItem[];
};

type CreatedUpload = {
  documentId: string;
  token: string;
  path: string;
};

type RefreshedUpload = {
  token: string;
  path: string;
};

type ApiErrorBody = {
  error?: ApiErrorPayload;
};

type DocumentProgress = {
  status: DocumentStatus;
  pageCount: number | null;
  embeddedChunks: number;
  totalChunks: number;
};

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await readJson<ApiErrorBody>(response);

  return getUploadErrorMessage(body?.error);
}

function isProcessing(document: DocumentListItem): boolean {
  return document.status === 'parsing' || document.status === 'embedding';
}

/**
 * Statuses only move forward. While the client has optimistically marked a
 * fresh upload as parsing, a list poll that still reads awaiting_upload must
 * not hide the parsing state (the ingest request may not have reached the
 * database yet).
 */
function mergeDocumentList(
  current: DocumentListItem[],
  incoming: DocumentListItem[],
): DocumentListItem[] {
  const currentById = new Map(
    current.map((document) => [document.id, document]),
  );

  return incoming.map((document) => {
    const previous = currentById.get(document.id);

    if (
      previous &&
      document.status === 'awaiting_upload' &&
      isProcessing(previous)
    ) {
      return {
        ...document,
        status: previous.status,
        pageCount: previous.pageCount ?? document.pageCount,
        embeddedChunks: previous.embeddedChunks,
        totalChunks: previous.totalChunks,
      };
    }

    return document;
  });
}

async function fetchDocumentList(): Promise<DocumentListItem[] | null> {
  try {
    const response = await fetch(DOCUMENTS_ENDPOINT, { cache: 'no-store' });

    if (!response.ok) {
      return null;
    }

    const body = await readJson<DocumentsResponse>(response);

    if (!body) {
      return null;
    }

    return body.documents ?? [];
  } catch {
    return null;
  }
}

export function useDocuments() {
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const applyDocumentList = useCallback(
    (nextDocuments: DocumentListItem[] | null) => {
      if (!mountedRef.current) {
        return;
      }

      if (nextDocuments) {
        setDocuments((current) => mergeDocumentList(current, nextDocuments));
        setError(null);
      } else {
        setError(DOCUMENTS_LOAD_MESSAGE);
      }

      setLoading(false);
    },
    [],
  );

  const refresh = useCallback(async () => {
    applyDocumentList(await fetchDocumentList());
  }, [applyDocumentList]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchDocumentList().then(applyDocumentList);

    return () => {
      mountedRef.current = false;
    };
  }, [applyDocumentList]);

  const shouldPoll = documents.some(isProcessing);

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    const intervalId = setInterval(() => {
      void refresh();
    }, DOCUMENTS_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [shouldPoll, refresh]);

  const updateDocumentProgress = useCallback(
    (documentId: string, next: DocumentProgress) => {
      if (!mountedRef.current) {
        return;
      }

      setDocuments((current) =>
        current.map((document) =>
          document.id === documentId
            ? {
                ...document,
                status: next.status,
                pageCount: next.pageCount ?? document.pageCount,
                embeddedChunks: next.embeddedChunks,
                totalChunks: next.totalChunks,
              }
            : document,
        ),
      );
    },
    [],
  );

  const uploadPdf = useCallback(
    async (file: File): Promise<string | null> => {
      const validationMessage = validatePdfFile(file);

      if (validationMessage) {
        toast.error(validationMessage);
        return null;
      }

      try {
        const createResponse = await fetch(DOCUMENTS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
          }),
        });

        if (!createResponse.ok) {
          toast.error(await readErrorMessage(createResponse));
          return null;
        }

        const created = await readJson<CreatedUpload>(createResponse);

        if (!created?.documentId || !created.path || !created.token) {
          toast.error(UPLOAD_GENERIC_MESSAGE);
          await refresh();
          return null;
        }

        const bucket = getBrowserClient().storage.from(STORAGE_BUCKET);
        const uploadOptions = { contentType: PDF_CONTENT_TYPE };

        let upload = await bucket.uploadToSignedUrl(
          created.path,
          created.token,
          file,
          uploadOptions,
        );

        if (upload.error) {
          const urlResponse = await fetch(
            `${DOCUMENTS_ENDPOINT}/${created.documentId}/upload-url`,
            { method: 'POST' },
          );

          if (!urlResponse.ok) {
            toast.error(await readErrorMessage(urlResponse));
            await refresh();
            return null;
          }

          const refreshed = await readJson<RefreshedUpload>(urlResponse);

          if (!refreshed?.path || !refreshed.token) {
            toast.error(UPLOAD_GENERIC_MESSAGE);
            await refresh();
            return null;
          }

          upload = await bucket.uploadToSignedUrl(
            refreshed.path,
            refreshed.token,
            file,
            uploadOptions,
          );
        }

        await refresh();

        if (upload.error) {
          toast.error(UPLOAD_RETRY_FAILED_MESSAGE);
          return null;
        }

        return created.documentId;
      } catch {
        toast.error(UPLOAD_GENERIC_MESSAGE);
        await refresh();
        return null;
      }
    },
    [refresh],
  );

  return { documents, loading, error, refresh, uploadPdf, updateDocumentProgress };
}
