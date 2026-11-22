const numberFormatter = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const MINUTE_MS = 60_000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;

  return `${numberFormatter.format(value)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatTimeLeft(
  expiresAt: string | Date,
  now: Date = new Date(),
): string {
  const target = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const remainingMs = target.getTime() - now.getTime();

  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 'Kedaluwarsa';
  }

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours} jam ${minutes} menit` : `${hours} jam`;
  }

  if (minutes > 0) {
    return `${minutes} menit`;
  }

  return 'kurang dari 1 menit';
}

export function formatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return dateFormatter.format(date);
}
