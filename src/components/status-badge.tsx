import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleX, Clock3, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { DocumentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

type StatusBadgeConfig = {
  label: string;
  variant: 'outline' | 'secondary' | 'destructive';
  icon: LucideIcon;
  className?: string;
  iconClassName?: string;
};

const STATUS_BADGE: Record<DocumentStatus, StatusBadgeConfig> = {
  awaiting_upload: {
    label: 'Menunggu upload',
    variant: 'outline',
    icon: Clock3,
    className: 'text-muted-foreground',
  },
  parsing: {
    label: 'Memproses…',
    variant: 'secondary',
    icon: LoaderCircle,
    iconClassName: 'animate-spin',
  },
  embedding: {
    label: 'Memproses…',
    variant: 'secondary',
    icon: LoaderCircle,
    iconClassName: 'animate-spin',
  },
  ready: {
    label: 'Siap ditanya',
    variant: 'outline',
    icon: CircleCheck,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  failed: {
    label: 'Gagal',
    variant: 'destructive',
    icon: CircleX,
  },
};

type StatusBadgeProps = {
  status: DocumentStatus;
  className?: string;
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUS_BADGE[status];
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={cn(config.className, className)}
    >
      <Icon aria-hidden="true" className={config.iconClassName} />
      {config.label}
    </Badge>
  );
}
