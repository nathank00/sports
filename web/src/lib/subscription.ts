import { SupabaseClient } from "@supabase/supabase-js";

export type Product = "terminal" | "autopilot";

export interface SubscriptionStatus {
  active: boolean;
  status: string;
  currentPeriodEnd: string | null;
}

/**
 * Check whether a user has an active subscription for a specific product.
 * Queries the `subscriptions` table in Supabase by (user_id, product_id).
 */
export async function getSubscriptionStatus(
  supabase: SupabaseClient,
  userId: string,
  product: Product = "terminal"
): Promise<SubscriptionStatus> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .eq("product_id", product)
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

/**
 * Fetch subscription statuses for all products a user may be subscribed to.
 * Used by the profile page to display all subscription info at once.
 */
export async function getAllSubscriptionStatuses(
  supabase: SupabaseClient,
  userId: string
): Promise<{ terminal: SubscriptionStatus; autopilot: SubscriptionStatus }> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("product_id, status, current_period_end")
    .eq("user_id", userId);

  const none: SubscriptionStatus = {
    active: false,
    status: "none",
    currentPeriodEnd: null,
  };

  const result = {
    terminal: { ...none },
    autopilot: { ...none },
  };

  if (!error && data) {
    for (const row of data) {
      const active = row.status === "active" || row.status === "trialing";
      const status: SubscriptionStatus = {
        active,
        status: row.status,
        currentPeriodEnd: row.current_period_end,
      };
      if (row.product_id === "terminal") result.terminal = status;
      if (row.product_id === "autopilot") result.autopilot = status;
    }
  }

  return result;
}
