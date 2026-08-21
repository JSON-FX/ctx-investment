import { requireAccount } from "@/lib/compound/load/account";
import { InvestorSheet } from "@/lib/compound/ui/investor-sheet";
import { deskHref } from "@/lib/compound/ui/routes";
import { addInvestor } from "../investor-actions";

export const dynamic = "force-dynamic";

export default async function InvestorPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;
  return (
    <InvestorSheet
      accountId={account.id}
      defaultSplitBps={account.defaultSplitBps}
      currency={account.currency}
      form={q}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={addInvestor}
    />
  );
}
