import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getDocumentForSession, isDocumentExpired } from '@/lib/documents';
import { getEnv } from '@/lib/env';
import { AppError, toErrorResponse } from '@/lib/errors';
import {
  INGEST_LIMIT,
  INGEST_WINDOW_SECONDS,
  createIngestDeps,
  runIngestStep,
} from '@/lib/ingest';
import {
  enforceGlobalQuota,
  enforceRateLimit,
  getClientIp,
  hashIp,
} from '@/lib/rate-limit';
import { assertSameOrigin } from '@/lib/security';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';

const documentIdSchema = z.uuid();
const NOT_FOUND_MESSAGE = 'Dokumen tidak ditemukan.';
const EXPIRED_MESSAGE = 'Dokumen sudah kedaluwarsa dan dihapus.';

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);

    const { id } = await params;
    const sessionId = readSessionId(request);

    if (!sessionId || !documentIdSchema.safeParse(id).success) {
      throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    }

    const supabase = getServiceClient();
    const env = getEnv();

    const ip = getClientIp(request.headers);
    await enforceRateLimit(
      supabase,
      `ingest:${hashIp(ip, env.RATE_LIMIT_SALT)}`,
      INGEST_LIMIT,
      INGEST_WINDOW_SECONDS,
    );

    // includeExpired lets an owned but expired row return 410 instead of 404.
    const document = await getDocumentForSession(supabase, id, sessionId, {
      includeExpired: true,
    });

    if (!document) {
      throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    }

    if (isDocumentExpired(document)) {
      throw new AppError('DOC_EXPIRED', 410, EXPIRED_MESSAGE);
    }

    // Only statuses that can produce work consume the daily batch quota;
    // 404s, 410s, and idempotent ready polls do not.
    if (document.status !== 'ready' && document.status !== 'failed') {
      await enforceGlobalQuota(
        supabase,
        'ingest',
        env.GLOBAL_DAILY_INGEST_BATCHES,
      );
    }

    const progress = await runIngestStep(createIngestDeps(supabase, env), {
      documentId: id,
      sessionId,
    });

    return NextResponse.json(progress);
  } catch (error) {
    return toErrorResponse(error);
  }
}
