import type { Metadata } from "next";
import { createServerClient } from "@/lib/supabase-server";
import { getAllSubscriptionStatuses } from "@/lib/subscription";
import { redirect } from "next/navigation";
import ProfileDashboard from "@/components/ProfileDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — Profile",
};

export default async function ProfilePage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/profile");
  }

  const subscriptions = await getAllSubscriptionStatuses(supabase, user.id);

  return (
    <ProfileDashboard
      email={user.email ?? ""}
      subscriptions={subscriptions}
    />
  );
}
