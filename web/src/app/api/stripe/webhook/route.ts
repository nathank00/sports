import Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase-server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * Get the current_period_end from a subscription.
 * In newer Stripe API versions, this lives on the subscription items.
 */
function getPeriodEnd(sub: Stripe.Subscription): string | null {
  // Try subscription items first (newer API versions)
  const firstItem = sub.items?.data?.[0];
  if (firstItem?.current_period_end) {
    return new Date(firstItem.current_period_end * 1000).toISOString();
  }

  // Fallback: try the raw object (older API versions still include it)
  const raw = sub as unknown as Record<string, unknown>;
  if (typeof raw.current_period_end === "number") {
    return new Date((raw.current_period_end as number) * 1000).toISOString();
  }

  return null;
}

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Webhook signature verification failed:", message);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;

      if (!userId || !session.subscription) {
        console.error("Missing userId or subscription in checkout session");
        break;
      }

      // Retrieve the full subscription with items expanded
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string,
        { expand: ["items.data"] }
      );

      await supabase.from("subscriptions").upsert(
        {
          user_id: userId,
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
          status: subscription.status,
          current_period_end: getPeriodEnd(subscription),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      console.log(`Subscription created for user ${userId}`);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;

      await supabase
        .from("subscriptions")
        .update({
          status: subscription.status,
          current_period_end: getPeriodEnd(subscription),
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);

      console.log(
        `Subscription ${subscription.id} updated: ${subscription.status}`
      );
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;

      await supabase
        .from("subscriptions")
        .update({
          status: "canceled",
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);

      console.log(`Subscription ${subscription.id} canceled`);
      break;
    }
  }

  return Response.json({ received: true });
}
