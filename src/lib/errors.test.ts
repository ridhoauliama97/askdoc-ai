// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, toErrorResponse } from '@/lib/errors';

describe('toErrorResponse', () => {
  it('serializes AppError with status, Retry-After, and the error body', async () => {
    const response = toErrorResponse(
      new AppError('RATE_LIMITED', 429, 'Coba lagi.', 30),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Coba lagi.',
        retryAfter: 30,
      },
    });
  });

  it('omits Retry-After and retryAfter when absent', async () => {
    const response = toErrorResponse(
      new AppError('NOT_FOUND', 404, 'Dokumen tidak ditemukan.'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Retry-After')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Dokumen tidak ditemukan.',
      },
    });
  });

  it('maps ZodError to VALIDATION_ERROR 400', async () => {
    const result = z.object({ name: z.string() }).safeParse({});
    if (result.success) {
      throw new Error('Expected the schema to fail.');
    }

    const response = toErrorResponse(result.error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('does not leak unknown error details', async () => {
    const response = toErrorResponse(new Error('internal database detail'));

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('internal database detail');
  });
});
