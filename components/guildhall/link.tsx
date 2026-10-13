"use client";
import {forwardRef,type AnchorHTMLAttributes} from "react";

const warmed=new Set<string>();
function warm(href:string){
 if(typeof document==='undefined'||!href.startsWith('/')||href.startsWith('//')||/\.[a-z0-9]{2,5}$/i.test(href))return;
 const url=new URL(href,location.href);if(url.pathname===location.pathname||warmed.has(url.pathname))return;
 const connection=(navigator as Navigator&{connection?:{saveData?:boolean}}).connection;if(connection?.saveData)return;
 warmed.add(url.pathname);const link=document.createElement('link');link.rel='prefetch';link.as='document';link.href=url.pathname;document.head.appendChild(link);
}
// Keep reliable document navigation; warm a page only when the visitor shows intent.
const Link=forwardRef<HTMLAnchorElement,AnchorHTMLAttributes<HTMLAnchorElement> & {href:string}>(function Link({href,children,onPointerEnter,onFocus,...props},ref){
 return <a ref={ref} href={href} {...props} onPointerEnter={e=>{warm(href);onPointerEnter?.(e)}} onFocus={e=>{warm(href);onFocus?.(e)}}>{children}</a>;
});
export default Link;
