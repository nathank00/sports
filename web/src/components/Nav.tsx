"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

const links = [
  { href: "/signals", label: "Signals" },
  { href: "/terminal", label: "Terminal" },
  { href: "/autopilot", label: "Autopilot" },
];

export default function Nav() {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <nav className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
        <Link
          href="/"
          className="font-mono text-lg tracking-widest text-neutral-100 hover:text-white transition-colors"
        >
          [ EDGEMASTER ]
        </Link>
        <div className="flex items-center gap-6">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm font-medium uppercase tracking-wider transition-colors ${
                pathname.startsWith(link.href)
                  ? "text-white"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {link.label}
            </Link>
          ))}

          {/* Auth state */}
          {user ? (
            <Link
              href="/profile"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-800 text-xs font-medium uppercase text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
              title="Profile"
            >
              {(user.email ?? "?")[0]}
            </Link>
          ) : (
            <Link
              href="/login"
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Sign In
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
