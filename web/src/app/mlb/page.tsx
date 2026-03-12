import type { Metadata } from "next";
import MlbDashboard from "@/components/MlbDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "[ EDGEMASTER ] — MLB",
};

export default function MlbPage() {
  return <MlbDashboard />;
}
