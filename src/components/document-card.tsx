import type { KeyboardEvent } from 'react';
import { Clock3, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/status-badge';
import { formatBytes, formatTimeLeft } from '@/lib/format';
import type { DocumentListItem } from '@/lib/types';
import { cn } from '@/lib/utils';

type DocumentCardProps = {
  document: DocumentListItem;
  selected?: boolean;
  onSelect?: (id: string) => void;
};

export function DocumentCard({
  document,
  selected = false,
  onSelect,
}: DocumentCardProps) {
  const {
    id,
    fileName,
    fileSize,
    pageCount,
    status,
    expiresAt,
    embeddedChunks,
    totalChunks,
  } = document;

  const timeLeft = formatTimeLeft(expiresAt);
  const progress =
    totalChunks > 0
      ? Math.round((embeddedChunks / totalChunks) * 100)
      : null;
  const isProcessing = status === 'parsing' || status === 'embedding';
  const details = [
    formatBytes(fileSize),
    pageCount === null ? null : `${pageCount} halaman`,
  ]
    .filter(Boolean)
    .join(' · ');

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(id);
    }
  }

  return (
    <li>
      <Card
        size="sm"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect?.(id)}
        onKeyDown={handleKeyDown}
        className={cn(
          'cursor-pointer gap-0 px-0 py-0 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          selected && 'bg-muted/60 ring-2 ring-primary/40',
        )}
      >
        <CardContent className="flex flex-col gap-2.5 py-3">
          <div className="flex items-start gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileText aria-hidden="true" className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={fileName}>
                {fileName}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{details}</p>
            </div>
            <StatusBadge status={status} />
          </div>

          {isProcessing ? (
            <div className="space-y-1">
              <Progress
                value={progress}
                aria-label={`Progres pemrosesan ${fileName}`}
                className="gap-1.5"
              />
              <p className="text-[11px] text-muted-foreground">
                {progress === null
                  ? 'Menyiapkan dokumen…'
                  : `${progress}% · ${embeddedChunks}/${totalChunks} chunk`}
              </p>
            </div>
          ) : status === 'awaiting_upload' ? (
            <p className="text-[11px] text-muted-foreground">
              Pemrosesan akan dimulai sebentar lagi.
            </p>
          ) : null}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock3 aria-hidden="true" className="size-3" />
            <span>
              {timeLeft === 'Kedaluwarsa' ? timeLeft : `Sisa ${timeLeft}`}
            </span>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
