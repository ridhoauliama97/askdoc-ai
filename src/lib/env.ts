import 'server-only';
import { z } from 'zod';

function requiredSecret(name: string) {
  return z.string().trim().min(1, `${name} wajib diisi.`);
}

function emptyStringToUndefined(value: unknown) {
  return value === '' ? undefined : value;
}

function positiveInt(defaultValue: number) {
  return z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().positive().default(defaultValue),
  );
}

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: requiredSecret(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ),
  SUPABASE_SERVICE_ROLE_KEY: requiredSecret('SUPABASE_SERVICE_ROLE_KEY'),
  GEMINI_API_KEY: requiredSecret('GEMINI_API_KEY'),
  GEMINI_CHAT_MODEL: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
  GEMINI_EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(1)
    .default('gemini-embedding-001'),
  RATE_LIMIT_SALT: requiredSecret('RATE_LIMIT_SALT'),
  CRON_SECRET: requiredSecret('CRON_SECRET'),
  DOC_TTL_HOURS: positiveInt(24),
  MAX_PDF_BYTES: positiveInt(15_728_640),
  MAX_PDF_PAGES: positiveInt(100),
  MAX_CHUNKS_PER_DOC: positiveInt(300),
  MAX_DOCS_PER_SESSION: positiveInt(5),
  INGEST_BATCH_SIZE: positiveInt(16),
  EMBEDDING_DIMENSIONS: positiveInt(768),
  MATCH_COUNT: positiveInt(5),
  MATCH_THRESHOLD: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().min(0).max(1).default(0.35),
  ),
  CHAT_HISTORY_MESSAGES: positiveInt(6),
  GLOBAL_DAILY_UPLOADS: positiveInt(50),
  GLOBAL_DAILY_INGEST_BATCHES: positiveInt(1_000),
  GLOBAL_DAILY_CHATS: positiveInt(300),
  GLOBAL_ACTIVE_STORAGE_BYTES: positiveInt(524_288_000),
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): AppEnv {
  return envSchema.parse(source);
}

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}
