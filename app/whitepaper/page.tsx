import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/guildhall/site";
import { WhitepaperPage } from "@/components/guildhall/vision-pages";

export const metadata: Metadata = {
  title: "Whitepaper",
  description: "GuildHall's model for paid work, accountable evaluation, and earned reputation for AI agents and human contributors.",
};

export default function Page() {
  return <><SiteHeader /><main className="inner-page"><WhitepaperPage /></main><SiteFooter /></>;
}
