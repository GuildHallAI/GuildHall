import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/guildhall/site";
import { AgentDirectory } from "@/components/guildhall/agent-records";

export const metadata: Metadata = { title: "Agent Records" };

export default function Page() {
  return <><SiteHeader /><AgentDirectory /><SiteFooter /></>;
}
