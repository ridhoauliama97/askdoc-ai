import { NextResponse, type NextRequest } from 'next/server';
import {
  SIGNED_UPLOAD_LIMIT,
  SIGNED_UPLOAD_WINDOW_SECONDS,
  STORAGE_BUCKET,
  buildStoragePath,
  getActiveDocumentCount,
  getActiveStorageBytes,
  isPdfFileName,
  sanitizeFileName,
  toDocumentListItem,
} from '@/lib/documents';
import { getEnv } from '@/lib/env';
import {
  AppError,
  INTERNAL_ERROR_MESSAGE,
  toErrorResponse,
} from '@/lib/errors';
import {
  enforceGlobalQuota,
  enforceRateLimit,
  getClientIp,
  hashIp,
} from '@/lib/rate-limit';
import { createDocumentSchema } from '@/lib/schemas';
import { assertSameOrigin } from '@/lib/security';
import { ensureSession, readSessionId, setSessionCookie } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError('VALIDATION_ERROR', 400, 'Data permintaan tidak valid.');
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = readSessionId(request);

    if (!sessionId) {
      return NextResponse.json({ documents: [] });
    }

    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('rag_documents')
      .select('*')
      .eq('session_id', sessionId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    return NextResponse.json({
      documents: (data ?? []).map((document) => toDocumentListItem(document)),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);

    const input = createDocumentSchema.parse(await readJsonBody(request));
    const env = getEnv();
    const maxPdfMb = Math.round(env.MAX_PDF_BYTES / (1024 * 1024));

    if (input.fileSize > env.MAX_PDF_BYTES) {
      throw new AppError(
        'FILE_TOO_LARGE',
        400,
        `Ukuran file melebihi ${maxPdfMb} MB.`,
      );
    }

    if (!isPdfFileName(input.fileName)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'File harus berformat PDF.',
      );
    }

    const supabase = getServiceClient();

    const ip = getClientIp(request.headers);
    await enforceRateLimit(
      supabase,
      `signed_upload:${hashIp(ip, env.RATE_LIMIT_SALT)}`,
      SIGNED_UPLOAD_LIMIT,
      SIGNED_UPLOAD_WINDOW_SECONDS,
    );

    const { sessionId, isNew } = await ensureSession(request, supabase);

    const activeCount = await getActiveDocumentCount(supabase, sessionId);

    if (activeCount >= env.MAX_DOCS_PER_SESSION) {
      throw new AppError(
        'DOC_LIMIT_REACHED',
        409,
        `Maksimal ${env.MAX_DOCS_PER_SESSION} dokumen aktif. Hapus dokumen lama untuk mengunggah lagi.`,
      );
    }

    const activeBytes = await getActiveStorageBytes(supabase);

    if (activeBytes + input.fileSize > env.GLOBAL_ACTIVE_STORAGE_BYTES) {
      throw new AppError(
        'GLOBAL_LIMIT_REACHED',
        429,
        'Kuota demo hari ini sudah habis. Silakan kembali besok ya.',
      );
    }

    await enforceGlobalQuota(supabase, 'upload', env.GLOBAL_DAILY_UPLOADS);

    const documentId = crypto.randomUUID();
    const storagePath = buildStoragePath(sessionId, documentId);

    const { error: insertError } = await supabase
      .from('rag_documents')
      .insert({
        id: documentId,
        session_id: sessionId,
        file_name: sanitizeFileName(input.fileName),
        file_size: input.fileSize,
        status: 'awaiting_upload',
        storage_path: storagePath,
      });

    if (insertError) {
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    const { data: upload, error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (uploadError || !upload) {
      await supabase.from('rag_documents').delete().eq('id', documentId);
      throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
    }

    const response = NextResponse.json(
      {
        documentId,
        signedUrl: upload.signedUrl,
        token: upload.token,
        path: storagePath,
      },
      { status: 201 },
    );

    if (isNew) {
      setSessionCookie(response, sessionId);
    }

    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
