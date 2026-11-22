'use client';

import { CircleAlert, FilePlus, FileText, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { UploadButton } from '@/components/upload-button';
import type { IngestError } from '@/hooks/use-ingest';
import type { DocumentListItem } from '@/lib/types';
import {
  DOCUMENT_TTL_HOURS,
  MAX_ACTIVE_DOCUMENTS,
  MAX_PDF_MB,
  MAX_PDF_PAGES,
} from '@/lib/upload';
import { cn } from '@/lib/utils';

type DocumentSidebarProps = {
  documents: DocumentListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpload: (file: File) => void | Promise<unknown>;
  isLoading?: boolean;
  isUploading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onResume?: (id: string) => void;
  onResumeError?: () => void;
  ingestError?: IngestError | null;
  resumeDisabled?: boolean;
  className?: string;
};

export function DocumentSidebar({
  documents,
  selectedId,
  onSelect,
  onUpload,
  isLoading = false,
  isUploading = false,
  error = null,
  onRetry,
  onResume,
  onResumeError,
  ingestError = null,
  resumeDisabled = false,
  className,
}: DocumentSidebarProps) {
  const errorFileName = ingestError
    ? (documents.find((document) => document.id === ingestError.documentId)
        ?.fileName ?? 'dokumen')
    : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-sidebar', className)}>
      <div className="shrink-0 border-b px-4 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <FileText aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="font-heading text-base leading-tight font-semibold">
              Ask Doc AI
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tanya jawab dari isi dokumen
            </p>
          </div>
        </div>

        <UploadButton
          onUpload={onUpload}
          isUploading={isUploading}
          className="mt-4"
        />

        {error ? (
          <Alert variant="destructive" className="mt-3 px-2.5 py-2">
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="text-xs leading-relaxed">
              <span className="block">{error}</span>
              {onRetry ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-1 h-auto p-0 text-xs"
                  onClick={onRetry}
                >
                  Coba lagi
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {ingestError ? (
          <Alert variant="destructive" className="mt-3 px-2.5 py-2">
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="text-xs leading-relaxed">
              <span className="block">{ingestError.message}</span>
              {ingestError.retryable && onResumeError ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-1 h-auto p-0 text-xs"
                  aria-label={`Lanjutkan pemrosesan ${errorFileName}`}
                  disabled={resumeDisabled}
                  onClick={onResumeError}
                >
                  Lanjutkan
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <Alert className="mt-3 border-border/70 bg-muted/40 px-2.5 py-2">
          <Info aria-hidden="true" />
          <AlertDescription className="text-xs leading-relaxed">
            PDF maks. {MAX_PDF_MB} MB, {MAX_PDF_PAGES} halaman. Dokumen dihapus
            otomatis setelah {DOCUMENT_TTL_HOURS} jam.
          </AlertDescription>
        </Alert>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Dokumen
          </h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {documents.length}/{MAX_ACTIVE_DOCUMENTS}
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {isLoading ? (
            <div
              className="space-y-2 px-3 pb-4"
              role="status"
              aria-label="Memuat dokumen"
            >
              <Skeleton className="h-[104px] w-full rounded-xl" />
              <Skeleton className="h-[104px] w-full rounded-xl" />
              <Skeleton className="h-[104px] w-full rounded-xl" />
              <span className="sr-only">Memuat dokumen…</span>
            </div>
          ) : documents.length === 0 ? (
            <EmptyState
              icon={FilePlus}
              title="Belum ada dokumen"
              description="Unggah PDF pertama Anda untuk mulai bertanya."
              className="py-6"
            />
          ) : (
            <ul className="space-y-2 px-3 pb-4">
              {documents.map((document) => (
                <DocumentCard
                  key={document.id}
                  document={document}
                  selected={document.id === selectedId}
                  onSelect={onSelect}
                  onResume={onResume}
                  resumeDisabled={resumeDisabled}
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
