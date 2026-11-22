import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  SIGNED_UPLOAD_LIMIT,
  SIGNED_UPLOAD_WINDOW_SECONDS,
  STORAGE_BUCKET,
  getDocumentForSession,
} from '@/lib/documents';
import { getEnv } from '@/lib/env';
import {
  AppError,
  INTERNAL_ERROR_MESSAGE,
  toErrorResponse,
} from '@/lib/errors';
import { enforceRateLimit, getClientIp, hashIp } from '@/lib/rate-limit';
import { assertSameOrigin } from '@/lib/security';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';

const documentIdSchema = z.uuid();
const NOT_FOUND_MESSAGE = 'Dokumen tidak ditemukan.';

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
      `signed_upload:${hashIp(ip, env.RATE_LIMIT_SALT)}`,
      SIGNED_UPLOAD_LIMIT,
      SIGNED_UPLOAD_WINDOW_SECONDS,
    );

    const document = await getDocumentForSession(supabase, id, sessionId);

    if (!document) {
      throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    }

    if (document.status !== 'awaiting_upload') {
      throw new AppError('DOC_NOT_READY', 409, 'Dokumen masih diproses.');
    }

    const { data: upload, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(document.storage_path);

    if (error || !upload) {
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    return NextResponse.json({
      signedUrl: upload.signedUrl,
      token: upload.token,
      path: document.storage_path,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
