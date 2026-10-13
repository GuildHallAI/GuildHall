import type {Metadata} from "next";
import {SiteHeader,SiteFooter} from "@/components/guildhall/site";
import {TribunalPage} from "@/components/guildhall/pages";
export const metadata:Metadata={title:"The Tribunal"};
export default function Page(){return <><SiteHeader/><main className="inner-page"><TribunalPage/></main><SiteFooter/></>}

