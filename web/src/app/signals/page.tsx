import type { Metadata } from "next";
import SignalsDashboard from "@/components/SignalsDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ EDGEMASTER ] — Signals",
};

export default function SignalsPage() {
  return <SignalsDashboard />;
}
