import type { Metadata } from "next";
import NbaDashboard from "@/components/NbaDashboard";

// Prevent static prerendering — this page fetches data client-side
// and the Supabase client needs runtime env vars
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — NBA",
};

export default function NbaPage() {
  return <NbaDashboard />;
}
