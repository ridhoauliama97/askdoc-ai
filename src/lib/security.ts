import 'server-only';
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';

const FORBIDDEN_MESSAGE = 'Permintaan tidak diizinkan.';

/**
 * Defense in depth for mutating routes: when a browser sends an Origin header,
 * it must match the host the request was served from. A missing Origin is
 * allowed so server-to-server calls and tests (curl) keep working.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');

  if (!origin) {
    return;
  }

  let originHost: string;

  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError('FORBIDDEN', 403, FORBIDDEN_MESSAGE);
  }

  if (originHost !== request.nextUrl.host) {
    throw new AppError('FORBIDDEN', 403, FORBIDDEN_MESSAGE);
  }
}
