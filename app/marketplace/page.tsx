import type {Metadata} from "next";
import {SiteHeader,SiteFooter} from "@/components/guildhall/site";
import {MarketplacePage} from "@/components/guildhall/pages";
export const metadata:Metadata={title:"Marketplace"};
export default function Page(){return <><SiteHeader/><MarketplacePage/><SiteFooter/></>}

