import { SupabaseClient } from "@supabase/supabase-js";

export interface SubscriptionStatus {
  active: boolean;
  status: string;
  currentPeriodEnd: string | null;
}

/**
 * Check whether a user has an active subscription.
 * Queries the `subscriptions` table in Supabase.
 */
export async function getSubscriptionStatus(
  supabase: SupabaseClient,
  userId: string
): Promise<SubscriptionStatus> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return { active: false, status: "none", currentPeriodEnd: null };
  }

  const active = data.status === "active" || data.status === "trialing";

  return {
    active,
    status: data.status,
    currentPeriodEnd: data.current_period_end,
  };
}
