import 'server-only';
import { createGoogle, type GoogleProvider } from '@ai-sdk/google';
import { embed, embedMany } from 'ai';
import { getEnv } from '@/lib/env';
import { AppError, INTERNAL_ERROR_MESSAGE } from '@/lib/errors';

/**
 * gemini-embedding-001 returns 3072 dimensions by default and only
 * auto-normalizes that size. The schema stores vector(768), so every vector
 * must be normalized here before it reaches Postgres.
 */
export const EMBEDDING_DIMENSIONS = 768;

export const AI_RATE_LIMITED_MESSAGE =
  'Layanan AI sedang sibuk. Coba lagi sebentar lagi.';

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const MAX_ATTEMPTS = 4;
const JITTER_MS = 250;
const MIN_RETRY_AFTER_SECONDS = 10;

export type GeminiRetryOptions = {
  /** Injectable for tests; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable for tests; must return a value in [0, 1). */
  random?: () => number;
};

type GoogleEmbeddingModel = ReturnType<GoogleProvider['embedding']>;

let googleProvider: GoogleProvider | undefined;

function getGoogleProvider(): GoogleProvider {
  googleProvider ??= createGoogle({ apiKey: getEnv().GEMINI_API_KEY });
  return googleProvider;
}

function getEmbeddingModel(): GoogleEmbeddingModel {
  return getGoogleProvider().embedding(getEnv().GEMINI_EMBEDDING_MODEL);
}

/**
 * L2-normalizes a vector. A zero vector is returned as zeros instead of NaN so
 * an unexpected provider response cannot poison the database.
 */
export function normalizeVector(values: number[]): number[] {
  let sumOfSquares = 0;

  for (const value of values) {
    sumOfSquares += value * value;
  }

  if (sumOfSquares === 0) {
    return values.map(() => 0);
  }

  const norm = Math.sqrt(sumOfSquares);

  return values.map((value) => value / norm);
}

/** Serializes a vector for pgvector columns and RPC parameters. */
export function toPgVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

function normalizeEmbedding(embedding: number[]): number[] {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError('INTERNAL_ERROR', 500, INTERNAL_ERROR_MESSAGE);
  }

  return normalizeVector(embedding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const direct = readNumber(error.statusCode) ?? readNumber(error.status);
  if (direct !== undefined) {
    return direct;
  }

  if (isRecord(error.cause)) {
    return (
      readNumber(error.cause.statusCode) ?? readNumber(error.cause.status)
    );
  }

  return undefined;
}

function isRetryable(error: unknown): boolean {
  const status = getStatus(error);

  return (
    status === 429 || (status !== undefined && status >= 500 && status < 600)
  );
}

function getHeaders(error: unknown): Record<string, string> | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const candidates = [
    error.responseHeaders,
    isRecord(error.response) ? error.response.headers : undefined,
    isRecord(error.cause) ? error.cause.responseHeaders : undefined,
    isRecord(error.cause) && isRecord(error.cause.response)
      ? error.cause.response.headers
      : undefined,
  ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      }
    }

    if (Object.keys(headers).length > 0) {
      return headers;
    }
  }

  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const explicitMs = readNumber(error.retryAfterMs);
  if (explicitMs !== undefined) {
    return Math.max(0, explicitMs);
  }

  const explicitSeconds = readNumber(error.retryAfter);
  if (explicitSeconds !== undefined) {
    return Math.max(0, explicitSeconds * 1_000);
  }

  return parseRetryAfter(getHeaders(error)?.['retry-after']);
}

function jitteredDelay(attempt: number, random: () => number): number {
  const base =
    RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  const jitter = Math.round((random() * 2 - 1) * JITTER_MS);

  return Math.max(0, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rateLimitedError(error: unknown, attempt: number): AppError {
  const retryAfterMs = getRetryAfterMs(error);
  const fallbackSeconds = Math.ceil(
    RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] / 1_000,
  );
  const retryAfter = Math.max(
    MIN_RETRY_AFTER_SECONDS,
    retryAfterMs === undefined
      ? fallbackSeconds
      : Math.ceil(retryAfterMs / 1_000),
  );

  return new AppError(
    'AI_RATE_LIMITED',
    429,
    AI_RATE_LIMITED_MESSAGE,
    retryAfter,
  );
}

/**
 * Retries only rate-limit and server failures, because the AI SDK call itself
 * uses maxRetries: 0. Client errors (400, 401, ...) surface immediately.
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  options: GeminiRetryOptions = {},
): Promise<T> {
  const wait = options.delay ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }

      if (attempt >= MAX_ATTEMPTS - 1) {
        throw rateLimitedError(error, attempt);
      }

      const retryAfterMs = getRetryAfterMs(error);
      await wait(retryAfterMs ?? jitteredDelay(attempt, random));
    }
  }
}

export async function embedDocumentChunks(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const model = getEmbeddingModel();
  const { embeddings } = await withGeminiRetry(() =>
    embedMany({
      model,
      values: texts,
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: 'RETRIEVAL_DOCUMENT',
        },
      },
    }),
  );

  return embeddings.map(normalizeEmbedding);
}

export async function embedQuestion(text: string): Promise<number[]> {
  const model = getEmbeddingModel();
  const { embedding } = await withGeminiRetry(() =>
    embed({
      model,
      value: text,
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: 'RETRIEVAL_QUERY',
        },
      },
    }),
  );

  return normalizeEmbedding(embedding);
}
