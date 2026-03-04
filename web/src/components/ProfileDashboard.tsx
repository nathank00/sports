"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import Link from "next/link";
import type { SubscriptionStatus } from "@/lib/subscription";

interface ProfileDashboardProps {
  email: string;
  subscriptions: {
    terminal: SubscriptionStatus;
    autopilot: SubscriptionStatus;
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ProfileDashboard({
  email,
  subscriptions,
}: ProfileDashboardProps) {
  const router = useRouter();
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const initial = (email[0] ?? "?").toUpperCase();
  const username = email.split("@")[0];

  const handleChangePassword = async () => {
    setPasswordLoading(true);
    setPasswordMsg(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?redirect=/profile`,
      });
      if (error) {
        setPasswordMsg(`Error: ${error.message}`);
      } else {
        setPasswordMsg("Password reset email sent. Check your inbox.");
      }
    } catch {
      setPasswordMsg("Failed to send reset email.");
    }
    setPasswordLoading(false);
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const resp = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await resp.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      // silently fail
    }
    setPortalLoading(false);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  const products: {
    key: "terminal" | "autopilot";
    name: string;
    href: string;
  }[] = [
    { key: "terminal", name: "Terminal", href: "/terminal" },
    { key: "autopilot", name: "Autopilot", href: "/autopilot" },
  ];

  const hasAnySub =
    subscriptions.terminal.active || subscriptions.autopilot.active;

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Avatar + Identity */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800 text-2xl font-bold uppercase text-white">
            {initial}
          </div>
          <h1 className="text-lg font-semibold text-white">{username}</h1>
          <p className="mt-1 text-sm text-neutral-400">{email}</p>
        </div>

        {/* Password */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-6">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Password
          </h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-300 tracking-widest">
              ••••••••
            </span>
            <button
              onClick={handleChangePassword}
              disabled={passwordLoading}
              className="text-xs text-neutral-400 hover:text-white transition-colors disabled:opacity-50"
            >
              {passwordLoading ? "Sending..." : "Change Password"}
            </button>
          </div>
          {passwordMsg && (
            <p
              className={`mt-3 text-xs ${
                passwordMsg.startsWith("Error")
                  ? "text-red-400"
                  : "text-green-400"
              }`}
            >
              {passwordMsg}
            </p>
          )}
        </div>

        {/* Subscriptions */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-6">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Subscriptions
          </h2>
          <div className="space-y-3">
            {products.map(({ key, name, href }) => {
              const sub = subscriptions[key];
              return (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3"
                >
                  <div>
                    <span className="text-sm font-medium text-white">
                      {name}
                    </span>
                    {sub.active && sub.currentPeriodEnd && (
                      <p className="text-xs text-neutral-500 mt-0.5">
                        Renews {formatDate(sub.currentPeriodEnd)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                        sub.active
                          ? "border border-green-500/20 bg-green-500/5 text-green-400"
                          : "border border-neutral-700 bg-neutral-800/50 text-neutral-500"
                      }`}
                    >
                      {sub.active ? "Active" : "Inactive"}
                    </span>
                    {!sub.active && (
                      <Link
                        href={href}
                        className="text-xs text-neutral-400 hover:text-white transition-colors"
                      >
                        Subscribe
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hasAnySub && (
            <button
              onClick={handleManageSubscription}
              disabled={portalLoading}
              className="mt-4 w-full rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white disabled:opacity-50"
            >
              {portalLoading
                ? "Opening portal..."
                : "Manage Subscriptions"}
            </button>
          )}
        </div>

        {/* Sign Out */}
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm text-neutral-400 transition-colors hover:border-neutral-700 hover:text-white disabled:opacity-50"
        >
          {signingOut ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </div>
  );
}
