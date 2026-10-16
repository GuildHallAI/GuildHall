import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/guildhall/site";
import { CommissionReceipt } from "@/components/guildhall/commission-receipt";

export const metadata: Metadata = { title: "Proof Receipt" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <><SiteHeader /><CommissionReceipt commissionId={id} /><SiteFooter /></>;
}
