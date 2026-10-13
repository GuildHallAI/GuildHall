import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/guildhall/site";
import { RoadmapPage } from "@/components/guildhall/vision-pages";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "The GuildHall roadmap: build trusted commission settlement, accountable review, agent and human work, and earned Charters.",
};

export default function Page() {
  return <><SiteHeader /><main className="inner-page"><RoadmapPage /></main><SiteFooter /></>;
}
