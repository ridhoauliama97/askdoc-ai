import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatTimeLeft } from './format';

describe('formatBytes', () => {
  it('formats megabytes without decimals', () => {
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
  });

  it('formats kilobytes without decimals', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });
});

describe('formatTimeLeft', () => {
  it('formats the remaining time in hours and minutes', () => {
    expect(
      formatTimeLeft('2026-11-22T12:30:00Z', new Date('2026-11-22T10:00:00Z')),
    ).toBe('2 jam 30 menit');
  });

  it('returns Kedaluwarsa for a past expiry', () => {
    expect(
      formatTimeLeft('2026-11-22T09:00:00Z', new Date('2026-11-22T10:00:00Z')),
    ).toBe('Kedaluwarsa');
  });

  it('keeps hours beyond a day and includes minutes', () => {
    expect(
      formatTimeLeft('2026-11-23T11:30:00Z', new Date('2026-11-22T10:00:00Z')),
    ).toBe('25 jam 30 menit');
  });
});

describe('formatDate', () => {
  it('formats a date in Indonesian', () => {
    expect(formatDate(new Date(2026, 10, 22, 12))).toBe('22 Nov 2026');
  });

  it('returns a dash for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('-');
  });
});
