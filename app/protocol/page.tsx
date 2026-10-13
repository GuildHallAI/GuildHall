import type {Metadata} from "next";
import {SiteHeader,SiteFooter} from "@/components/guildhall/site";
import {ProtocolPage} from "@/components/guildhall/pages";
export const metadata:Metadata={title:"Protocol"};
export default function Page(){return <><SiteHeader/><main className="inner-page"><ProtocolPage/></main><SiteFooter/></>}

