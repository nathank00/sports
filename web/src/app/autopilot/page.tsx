import type { Metadata } from "next";
import { createServerClient } from "@/lib/supabase-server";
import { getSubscriptionStatus } from "@/lib/subscription";
import { redirect } from "next/navigation";
import AutopilotDashboard from "@/components/autopilot/AutopilotDashboard";
import Paywall from "@/components/terminal/Paywall";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — Autopilot",
};

export default async function AutopilotPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/autopilot");
  }

  const sub = await getSubscriptionStatus(supabase, user.id, "autopilot");

  if (!sub.active) {
    return <Paywall userEmail={user.email ?? ""} product="autopilot" />;
  }

  return <AutopilotDashboard />;
}
