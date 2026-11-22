import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  getChunkProgress,
  getDocumentForSession,
  toDocumentListItem,
} from '@/lib/documents';
import { AppError, toErrorResponse } from '@/lib/errors';
import { readSessionId } from '@/lib/session';
import { getServiceClient } from '@/lib/supabase/server';

const documentIdSchema = z.uuid();
const NOT_FOUND_MESSAGE = 'Dokumen tidak ditemukan.';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = readSessionId(request);

    if (!sessionId || !documentIdSchema.safeParse(id).success) {
      throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    }

    const supabase = getServiceClient();
    const document = await getDocumentForSession(supabase, id, sessionId);

    if (!document) {
      throw new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGE);
    }

    const progress = await getChunkProgress(supabase, document.id, document);

    return NextResponse.json({
      document: toDocumentListItem(document, progress),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
