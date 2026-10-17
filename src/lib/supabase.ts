import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

/**
 * Standard public Supabase client instance.
 * For authenticated requests using Clerk, use `createClerkSupabaseClient`.
 */
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Factory to create a Supabase client configured with a Clerk JWT token.
 * This sends the Clerk session token in the Authorization header to validate
 * against Supabase's third-party Clerk auth provider.
 */
export function createClerkSupabaseClient(clerkToken?: string | null): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: clerkToken ? { Authorization: `Bearer ${clerkToken}` } : {},
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
