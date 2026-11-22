// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, INTERNAL_ERROR_MESSAGE } from '@/lib/errors';
import {
  embedDocumentChunks,
  embedQuestion,
  normalizeVector,
  toPgVector,
  withGeminiRetry,
} from '@/lib/embeddings';

const { createGoogleMock, embeddingModelMock, embedMock, embedManyMock } =
  vi.hoisted(() => {
    const embeddingModelMock = vi.fn((modelId: string) => ({
      provider: 'google.embedding',
      modelId,
    }));
    const createGoogleMock = vi.fn(() => ({ embedding: embeddingModelMock }));

    return {
      createGoogleMock,
      embeddingModelMock,
      embedMock: vi.fn(),
      embedManyMock: vi.fn(),
    };
  });

vi.mock('@ai-sdk/google', () => ({ createGoogle: createGoogleMock }));
vi.mock('ai', () => ({ embed: embedMock, embedMany: embedManyMock }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  }),
}));

const DIMENSIONS = 768;

function vectorWith(...values: number[]): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);

  values.forEach((value, index) => {
    vector[index] = value;
  });

  return vector;
}

function l2Norm(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

function httpError(status: number, retryAfter?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    statusCode: status,
    ...(retryAfter
      ? { responseHeaders: { 'retry-after': retryAfter } }
      : {}),
  });
}

function delayRecorder() {
  const delays: number[] = [];

  return {
    delays,
    delay: async (ms: number) => {
      delays.push(ms);
    },
    random: () => 0.5,
  };
}

beforeEach(() => {
  embedMock.mockReset();
  embedManyMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeVector', () => {
  it('scales a vector to unit length', () => {
    const result = normalizeVector([3, 4]);

    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    expect(l2Norm(result)).toBeCloseTo(1);
  });

  it('keeps a zero vector as zeros instead of producing NaN', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
    expect(normalizeVector([0, 0]).every(Number.isFinite)).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = [3, 4];

    normalizeVector(input);

    expect(input).toEqual([3, 4]);
  });
});

describe('toPgVector', () => {
  it('serializes values in pgvector text format', () => {
    expect(toPgVector([0.1, -0.2])).toBe('[0.1,-0.2]');
  });
});

describe('embedDocumentChunks', () => {
  it('uses RETRIEVAL_DOCUMENT at 768 dimensions with maxRetries 0', async () => {
    embedManyMock.mockResolvedValue({
      embeddings: [vectorWith(3, 4), vectorWith(0, 5)],
    });

    const result = await embedDocumentChunks(['a', 'b']);

    expect(createGoogleMock).toHaveBeenCalledWith({
      apiKey: 'test-gemini-key',
    });
    expect(embeddingModelMock).toHaveBeenCalledWith('gemini-embedding-001');
    expect(embedManyMock).toHaveBeenCalledTimes(1);
    expect(embedManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: 'gemini-embedding-001' }),
        values: ['a', 'b'],
        maxRetries: 0,
        providerOptions: {
          google: {
            outputDimensionality: 768,
            taskType: 'RETRIEVAL_DOCUMENT',
          },
        },
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(DIMENSIONS);
    expect(result[1]).toHaveLength(DIMENSIONS);
    expect(result[0][0]).toBeCloseTo(0.6);
    expect(result[0][1]).toBeCloseTo(0.8);
    expect(result[1][1]).toBeCloseTo(1);
    expect(l2Norm(result[0])).toBeCloseTo(1);
    expect(l2Norm(result[1])).toBeCloseTo(1);
  });

  it('rejects vectors that are not 768 dimensions', async () => {
    embedManyMock.mockResolvedValue({
      embeddings: [new Array<number>(767).fill(0.1)],
    });

    const error = await embedDocumentChunks(['a']).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).status).toBe(500);
    expect((error as AppError).message).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('returns an empty array without calling Gemini for empty input', async () => {
    await expect(embedDocumentChunks([])).resolves.toEqual([]);
    expect(embedManyMock).not.toHaveBeenCalled();
  });
});

describe('embedQuestion', () => {
  it('uses RETRIEVAL_QUERY at 768 dimensions with maxRetries 0', async () => {
    embedMock.mockResolvedValue({ embedding: vectorWith(3, 4) });

    const result = await embedQuestion('q');

    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: 'gemini-embedding-001' }),
        value: 'q',
        maxRetries: 0,
        providerOptions: {
          google: {
            outputDimensionality: 768,
            taskType: 'RETRIEVAL_QUERY',
          },
        },
      }),
    );
    expect(result).toHaveLength(DIMENSIONS);
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    expect(l2Norm(result)).toBeCloseTo(1);
  });

  it('rejects vectors that are not 768 dimensions', async () => {
    embedMock.mockResolvedValue({
      embedding: new Array<number>(768).fill(0).concat([1]),
    });

    const error = await embedQuestion('q').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).status).toBe(500);
  });
});

describe('withGeminiRetry', () => {
  it('retries a 429 twice and then succeeds on the third attempt', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('applies up to 250ms of jitter around the base delay', async () => {
    const { delays, delay } = delayRecorder();
    const randomValues = [0, 1];
    const random = () => randomValues.shift() ?? 0.5;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(delays).toEqual([750, 2_250]);
  });

  it('retries 5xx responses', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000]);
  });

  it('honors the Retry-After header instead of the base delay', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, '7'))
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(delays).toEqual([7_000]);
  });

  it('throws AI_RATE_LIMITED after four consecutive 429s', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi.fn().mockRejectedValue(httpError(429));

    const error = await withGeminiRetry(fn, { delay, random }).catch(
      (caught: unknown) => caught,
    );

    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('AI_RATE_LIMITED');
    expect((error as AppError).status).toBe(429);
    expect((error as AppError).retryAfter).toBeGreaterThanOrEqual(10);
  });

  it('reports a Retry-After of at least 10 seconds on exhaustion', async () => {
    const { delay, random } = delayRecorder();
    const fn = vi.fn().mockRejectedValue(httpError(429, '12'));

    const error = await withGeminiRetry(fn, { delay, random }).catch(
      (caught: unknown) => caught,
    );

    expect((error as AppError).retryAfter).toBe(12);
  });

  it.each([400, 401])('does not retry HTTP %i', async (status) => {
    const { delays, delay, random } = delayRecorder();
    const original = httpError(status);
    const fn = vi.fn().mockRejectedValue(original);

    const error = await withGeminiRetry(fn, { delay, random }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('detects the status from error.status', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('', {}), { status: 429 }))
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000]);
  });

  it('detects the status from error.cause.statusCode', async () => {
    const { delays, delay, random } = delayRecorder();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('wrapped'), {
          cause: { statusCode: 429 },
        }),
      )
      .mockResolvedValue('ok');

    await expect(withGeminiRetry(fn, { delay, random })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000]);
  });
});
