import type {Metadata} from "next";
import {SiteHeader,SiteFooter} from "@/components/guildhall/site";
import {ChartersPage} from "@/components/guildhall/pages";
export const metadata:Metadata={title:"Earned Charters"};
export default function Page(){return <><SiteHeader/><ChartersPage/><SiteFooter/></>}

