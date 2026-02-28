import type { Metadata } from "next";
import { createServerClient } from "@/lib/supabase-server";
import { getSubscriptionStatus } from "@/lib/subscription";
import { redirect } from "next/navigation";
import Terminal from "@/components/terminal/Terminal";
import Paywall from "@/components/terminal/Paywall";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — Terminal",
};

export default async function TerminalPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/terminal");
  }

  const sub = await getSubscriptionStatus(supabase, user.id);

  if (!sub.active) {
    return <Paywall userEmail={user.email ?? ""} />;
  }

  return <Terminal />;
}
