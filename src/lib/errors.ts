import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'FILE_TOO_LARGE'
  | 'PDF_TOO_MANY_PAGES'
  | 'PDF_TOO_MANY_CHUNKS'
  | 'PDF_NO_TEXT'
  | 'PDF_INVALID'
  | 'DOC_LIMIT_REACHED'
  | 'DOC_NOT_READY'
  | 'DOC_EXPIRED'
  | 'INGEST_BUSY'
  | 'RATE_LIMITED'
  | 'GLOBAL_LIMIT_REACHED'
  | 'AI_RATE_LIMITED'
  | 'UPLOAD_NOT_FOUND'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR';

export const INTERNAL_ERROR_MESSAGE = 'Terjadi kesalahan pada server.';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    retryAfter?: number;
  };
};

function errorBody(
  code: ErrorCode,
  message: string,
  retryAfter?: number,
): ErrorBody {
  return {
    error:
      retryAfter === undefined
        ? { code, message }
        : { code, message, retryAfter },
  };
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) {
    const response = NextResponse.json(
      errorBody(error.code, error.message, error.retryAfter),
      { status: error.status },
    );

    if (error.retryAfter !== undefined) {
      response.headers.set('Retry-After', String(error.retryAfter));
    }

    return response;
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      errorBody('VALIDATION_ERROR', 'Data permintaan tidak valid.'),
      { status: 400 },
    );
  }

  return NextResponse.json(
    errorBody('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE),
    { status: 500 },
  );
}
