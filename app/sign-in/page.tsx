/**
 * Email and password against Supabase Auth. No sign-up, no reset, no magic
 * link: single-tenant, one operator (D1), and the directory is CopyTraderX's,
 * which already has its own account management.
 */
import { redirect } from "next/navigation";
import { authClient } from "@/lib/compound/load/supabase";
import { Field, FieldError, Sheet, SheetActions } from "@/lib/compound/ui/sheet";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const supabase = await authClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
  redirect("/");
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; denied?: string }>;
}) {
  const { error, denied } = await searchParams;
  return (
    // backHref="/": there is nothing to cancel back to from sign-in itself.
    // "/" is still an honest destination — requireManager redirects an
    // unauthenticated visitor straight back here. The plan's draft used
    // backHref="/sign-in" backLabel="" for this, which renders <a
    // href="/sign-in"></a>: a link with no accessible name, the same defect
    // shape flagged in Task 4's report. No test in this codebase exercises
    // backLabel="" (sheet.test.tsx only ever passes the default "Cancel" or a
    // real label), so nothing depends on the empty string. Kept the default
    // "Cancel" label instead and pointed it at "/" so it always has a name a
    // screen reader can announce.
    <Sheet title="Compound" lede="Fund administration for pooled MetaTrader accounts." backHref="/">
      {denied ? (
        <FieldError>
          That account is signed in but is not an administrator. Compound adds no
          roles of its own; access is the existing admin claim.
        </FieldError>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      <form action={signIn}>
        <Field name="email" label="Email">
          <input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field name="password" label="Password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <SheetActions>
          <button className="btn btn-primary" type="submit">
            Sign in
          </button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
