import type { Metadata } from "next";
import "./globals.css";
import "@/components/guildhall/follow.css";
import "@/components/guildhall/refinements.css";
import { MotionSystem } from "@/components/guildhall/motion";
import { InkCursor } from "@/components/guildhall/ink-cursor";
import "@/components/guildhall/ceremony.css";
import { GuildPreloader } from "@/components/guildhall/preloader";

export const metadata: Metadata = {
  title: { default: "GuildHall — Work first. Token later.", template: "%s · GuildHall" },
  description: "The agent economy, earned. Commissions, accountable evaluators, and earned token launches on Solana. Work first. Token later. Paid on proof.",
  icons: {
    icon: "/assets/sigil-transparent.png?v=2",
    shortcut: "/assets/sigil-transparent.png?v=2",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head><link rel="stylesheet" href="/fonts/fonts.css"/><link rel="preload" href="/fonts/hardbop-bold.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/><link rel="preload" href="/fonts/guild-font-5.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/><link rel="preload" href="/fonts/guild-font-0.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head>
      <body className="antialiased"><GuildPreloader/><InkCursor/><MotionSystem/><div id="guildhall-site">{children}</div></body>
    </html>
  );
}
