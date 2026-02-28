import Stripe from "stripe";
import { createServerClient } from "@/lib/supabase-server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  // 1. Authenticate the user
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Check if user already has an active subscription
  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user.id)
    .single();

  if (existingSub?.status === "active") {
    return Response.json(
      { error: "You already have an active subscription" },
      { status: 400 }
    );
  }

  // 3. Look up the active price for the product
  const prices = await stripe.prices.list({
    product: process.env.STRIPE_PRODUCT_ID!,
    active: true,
    limit: 1,
  });

  if (prices.data.length === 0) {
    return Response.json(
      { error: "No active price found for product" },
      { status: 500 }
    );
  }

  const priceId = prices.data[0].id;

  // 4. Create Stripe Checkout Session
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: user.email,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${siteUrl}/terminal?checkout=success`,
    cancel_url: `${siteUrl}/terminal?checkout=canceled`,
    metadata: { supabase_user_id: user.id },
  });

  return Response.json({ url: session.url });
}
