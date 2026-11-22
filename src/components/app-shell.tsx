'use client';

import { useEffect, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { ChatPanel } from '@/components/chat-panel';
import { DocumentSidebar } from '@/components/document-sidebar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useDocuments } from '@/hooks/use-documents';
import { useIngest } from '@/hooks/use-ingest';

export function AppShell() {
  const {
    documents,
    loading,
    error,
    refresh,
    uploadPdf,
    updateDocumentProgress,
  } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const {
    progress: ingestProgress,
    isRunning: isIngesting,
    error: ingestError,
    start: startIngest,
    resume: resumeIngest,
  } = useIngest(selectedId);

  const selectedDocument =
    documents.find((document) => document.id === selectedId) ?? null;

  useEffect(() => {
    if (ingestProgress) {
      updateDocumentProgress(ingestProgress.documentId, ingestProgress);
    }
  }, [ingestProgress, updateDocumentProgress]);

  useEffect(() => {
    if (ingestProgress?.status === 'ready') {
      void refresh();
    }
  }, [ingestProgress?.status, refresh]);

  useEffect(() => {
    if (ingestError) {
      void refresh();
    }
  }, [ingestError, refresh]);

  function selectDocument(id: string) {
    setSelectedId(id);
    setIsSidebarOpen(false);
  }

  function resumeDocument(id: string) {
    setSelectedId(id);
    setIsSidebarOpen(false);
    void startIngest(id);
  }

  async function handleUpload(file: File) {
    setIsUploading(true);

    try {
      const documentId = await uploadPdf(file);

      if (documentId) {
        setSelectedId(documentId);
        setIsSidebarOpen(false);
        void startIngest(documentId);
      }
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-muted/20">
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-3 md:hidden">
        <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
          <SheetTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Buka daftar dokumen"
              />
            }
          >
            <PanelLeft aria-hidden="true" />
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-80 max-w-[85vw] gap-0 p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Dokumen</SheetTitle>
              <SheetDescription>Daftar dokumen pada sesi ini.</SheetDescription>
            </SheetHeader>
            <DocumentSidebar
              documents={documents}
              selectedId={selectedId}
              onSelect={selectDocument}
              onUpload={handleUpload}
              isLoading={loading}
              isUploading={isUploading}
              error={error}
              onRetry={() => void refresh()}
              onResume={resumeDocument}
              onResumeError={() => void resumeIngest()}
              ingestError={ingestError}
              resumeDisabled={isIngesting}
            />
          </SheetContent>
        </Sheet>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">Ask Doc AI</p>
          <p className="truncate text-xs text-muted-foreground">
            Tanya jawab dokumen PDF
          </p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-80 shrink-0 border-r bg-sidebar md:flex md:flex-col">
          <DocumentSidebar
            documents={documents}
            selectedId={selectedId}
            onSelect={selectDocument}
            onUpload={handleUpload}
            isLoading={loading}
            isUploading={isUploading}
            error={error}
            onRetry={() => void refresh()}
            onResume={resumeDocument}
            onResumeError={() => void resumeIngest()}
            ingestError={ingestError}
            resumeDisabled={isIngesting}
          />
        </aside>

        <ChatPanel document={selectedDocument} />
      </div>
    </div>
  );
}
