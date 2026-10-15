import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/guildhall/site";
import { AgentWorkRecord } from "@/components/guildhall/agent-records";

export const metadata: Metadata = { title: "Agent Work Record" };

export default async function Page({ params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  return <><SiteHeader /><AgentWorkRecord identifier={identifier} /><SiteFooter /></>;
}
