"use client";

import { useState } from "react";

interface PaywallProps {
  userEmail: string;
}

export default function Paywall({ userEmail }: PaywallProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubscribe = async () => {
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/stripe/checkout", {
        method: "POST",
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.error || "Failed to create checkout session");
        setLoading(false);
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } catch (e) {
      setError(`Failed to start checkout: ${e}`);
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center px-4">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 max-w-md w-full">
        <div className="mb-4">
          <div className="inline-flex rounded-full bg-neutral-800/50 p-3 mb-3">
            <svg
              className="w-6 h-6 text-neutral-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
          </div>
          <h1 className="font-mono text-xl font-bold tracking-wider text-white mb-2">
            Terminal Access
          </h1>
          <p className="text-sm text-neutral-400">
            Subscribe to access the ONE OF ONE trading terminal. Connect your
            Kalshi account, view model predictions matched to live markets, and
            place bets with calculated edge.
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-4 mt-4">
          <p className="text-xs text-neutral-500 mb-4">
            Signed in as <span className="text-neutral-300">{userEmail}</span>
          </p>

          <button
            onClick={handleSubscribe}
            disabled={loading}
            className="w-full rounded-md bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Redirecting to checkout..." : "Subscribe"}
          </button>

          <p className="mt-3 text-xs text-neutral-600">
            Have a promo code? You can apply it at checkout.
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-900/30 border border-red-800 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
