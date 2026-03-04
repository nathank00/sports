import Stripe from "stripe";
import { createServerClient } from "@/lib/supabase-server";
import type { Product } from "@/lib/subscription";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request) {
  // 1. Parse product from request body
  const body = await request.json().catch(() => ({}));
  const product: Product =
    body.product === "autopilot" ? "autopilot" : "terminal";

  // 2. Authenticate the user
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 3. Check if user already has an active subscription for this product
  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user.id)
    .eq("product_id", product)
    .single();

  if (existingSub?.status === "active") {
    return Response.json(
      { error: `You already have an active ${product} subscription` },
      { status: 400 }
    );
  }

  // 4. Look up the correct Stripe product ID
  const stripeProductId =
    product === "autopilot"
      ? process.env.STRIPE_AUTOPILOT_PRODUCT_ID
      : process.env.STRIPE_TERMINAL_PRODUCT_ID || process.env.STRIPE_PRODUCT_ID;

  if (!stripeProductId) {
    return Response.json(
      { error: "Product not configured" },
      { status: 500 }
    );
  }

  // 5. Look up the active price for the product
  const prices = await stripe.prices.list({
    product: stripeProductId,
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

  // 6. Create Stripe Checkout Session
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: user.email,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${siteUrl}/${product}?checkout=success`,
    cancel_url: `${siteUrl}/${product}?checkout=canceled`,
    metadata: { supabase_user_id: user.id, product },
  });

  return Response.json({ url: session.url });
}
