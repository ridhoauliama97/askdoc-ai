'use client';

import { FileText, MessageSquareText, Send } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { formatTimeLeft } from '@/lib/format';
import type { DocumentListItem } from '@/lib/types';
import { cn } from '@/lib/utils';

type ChatPanelProps = {
  document?: DocumentListItem | null;
  className?: string;
};

export function ChatPanel({ document = null, className }: ChatPanelProps) {
  const timeLeft = document ? formatTimeLeft(document.expiresAt) : null;
  const metadata = document
    ? [
        document.pageCount === null ? null : `${document.pageCount} halaman`,
        timeLeft === 'Kedaluwarsa' ? timeLeft : `Sisa ${timeLeft}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Belum ada dokumen yang dipilih';

  return (
    <section
      aria-label="Chat"
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-background',
        className,
      )}
    >
      <header className="flex min-h-[61px] shrink-0 items-center gap-3 border-b px-4 py-3 md:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <FileText aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {document ? document.fileName : 'Pilih dokumen'}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{metadata}</p>
        </div>
        {document ? <StatusBadge status={document.status} /> : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div
          aria-live="polite"
          className="flex min-h-[320px] items-center justify-center p-4 md:p-8"
        >
          <EmptyState
            icon={MessageSquareText}
            title="Mulai percakapan"
            description="Pilih dokumen di kiri, lalu tanyakan apa saja tentang isinya."
            className="max-w-md"
          />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t bg-background p-3 md:p-4">
        <form
          className="mx-auto w-full max-w-3xl"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="rounded-xl border bg-card p-2">
            <Textarea
              aria-label="Pertanyaan"
              placeholder={
                document
                  ? 'Tanya apa saja tentang dokumen ini…'
                  : 'Pilih dokumen dulu untuk mulai bertanya.'
              }
              disabled
              className="min-h-16 resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0 disabled:opacity-70"
            />
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <p className="hidden text-[11px] text-muted-foreground sm:block">
                Enter untuk kirim · Shift+Enter untuk baris baru
              </p>
              <Button type="submit" size="sm" disabled className="ml-auto">
                <Send aria-hidden="true" className="size-3.5" />
                Kirim
              </Button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
