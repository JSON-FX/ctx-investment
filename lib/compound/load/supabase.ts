/**
 * The Supabase Auth client. Auth only — Compound reads and writes its data
 * over pg (plan 3, decision P2), because PostgREST serialises bigint as a JSON
 * number and every cent figure would become a float.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function authClient() {
  const store = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. See .env.example.",
    );
  }
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        // A Server Component cannot set a cookie. middleware.ts refreshes the
        // session, so this is a no-op on the read path rather than a crash.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* called from a Server Component render; middleware handles refresh */
        }
      },
    },
  });
}
