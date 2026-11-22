'use client';

import { useState } from 'react';
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

export function AppShell() {
  const { documents, loading, error, refresh, uploadPdf } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const selectedDocument =
    documents.find((document) => document.id === selectedId) ?? null;

  function selectDocument(id: string) {
    setSelectedId(id);
    setIsSidebarOpen(false);
  }

  async function handleUpload(file: File) {
    setIsUploading(true);

    try {
      const documentId = await uploadPdf(file);

      if (documentId) {
        setSelectedId(documentId);
        setIsSidebarOpen(false);
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
          />
        </aside>

        <ChatPanel document={selectedDocument} />
      </div>
    </div>
  );
}
