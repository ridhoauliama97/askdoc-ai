import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | undefined;

export function getBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY wajib diisi.',
      );
    }

    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return browserClient;
}
