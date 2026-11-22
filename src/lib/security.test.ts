// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { assertSameOrigin } from '@/lib/security';

function requestWithOrigin(origin?: string): NextRequest {
  const headers = new Headers();
  if (origin !== undefined) {
    headers.set('origin', origin);
  }

  return new NextRequest('https://askdoc.example/api/chat', {
    method: 'POST',
    headers,
  });
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the action to throw.');
}

describe('assertSameOrigin', () => {
  it('allows a request without an Origin header', () => {
    expect(() => assertSameOrigin(requestWithOrigin())).not.toThrow();
  });

  it('allows the same host', () => {
    expect(() =>
      assertSameOrigin(requestWithOrigin('https://askdoc.example')),
    ).not.toThrow();
  });

  it('rejects a different origin host', () => {
    const error = captureError(() =>
      assertSameOrigin(requestWithOrigin('https://evil.example')),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Permintaan tidak diizinkan.',
    });
  });

  it('rejects a different port on the same host', () => {
    expect(() =>
      assertSameOrigin(requestWithOrigin('https://askdoc.example:8443')),
    ).toThrow(AppError);
  });

  it('rejects a malformed Origin header', () => {
    expect(() =>
      assertSameOrigin(requestWithOrigin('not-a-url')),
    ).toThrow(AppError);
  });
});
