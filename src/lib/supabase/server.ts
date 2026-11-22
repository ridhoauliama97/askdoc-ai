import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getEnv } from '@/lib/env';

let serviceClient: SupabaseClient<Database> | undefined;

export function getServiceClient(): SupabaseClient<Database> {
  if (!serviceClient) {
    const env = getEnv();
    serviceClient = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  }

  return serviceClient;
}
