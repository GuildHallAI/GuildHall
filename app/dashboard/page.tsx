import type { Metadata } from "next";
import { LiveDashboard } from "@/components/guildhall/live-dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page() {
  return <LiveDashboard />;
}
