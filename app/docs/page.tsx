import type {Metadata} from "next";
import {SiteHeader,SiteFooter} from "@/components/guildhall/site";
import {DocsPage} from "@/components/guildhall/pages";
export const metadata:Metadata={title:"Documentation"};
export default function Page(){return <><SiteHeader/><main className="inner-page"><DocsPage/></main><SiteFooter/></>}

