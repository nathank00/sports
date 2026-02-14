import type { Metadata } from "next";
import MlbDashboard from "@/components/MlbDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ ONE OF ONE ] — MLB",
};

export default function MlbPage() {
  return <MlbDashboard />;
}
