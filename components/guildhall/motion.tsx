"use client";
import {useEffect} from 'react';
import {usePathname} from 'next/navigation';

export function MotionSystem(){
 const path=usePathname();
 useEffect(()=>{
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const animations:Animation[]=[];
  const selector='.reveal,.record-step,.record-evidence-card,.record-hero-copy,.record-journey-heading,.record-ending>h2,.charter-title,.charter-offer,.reliquary-register,.reliquary-seals,.reliquary-verdict,.charter-mechanic,.faq-group,.page-title-row>*,.registry-content>header,.registry-new,.registry-notice,.registry-agent>header,.registry-agent>p,.registry-agent-stats,.dashboard-panel,.metric-card,.dashboard-agents>.agent-card';
  const seen=new WeakSet<Element>();
  const observer=new IntersectionObserver(entries=>{
   entries.forEach((entry,i)=>{if(!entry.isIntersecting)return;const el=entry.target as HTMLElement;el.classList.add('motion-shown');const animation=el.animate([{opacity:.18,translate:'0 25px',filter:'blur(2px)'},{opacity:1,translate:'0 0',filter:'blur(0px)'}],{duration:850,delay:Math.min(i*65,195),easing:'cubic-bezier(.16,1,.3,1)'});animations.push(animation);observer.unobserve(el)});
  },{threshold:.12,rootMargin:'0px 0px -24px 0px'});
  const scan=()=>document.querySelectorAll(selector).forEach(el=>{if(!seen.has(el)){seen.add(el);el.classList.add('motion-ready');observer.observe(el)}});
  scan();const mutation=new MutationObserver(scan);const content=document.getElementById('guildhall-site');if(content)mutation.observe(content,{childList:true,subtree:true});
  const move=(e:PointerEvent)=>{const card=(e.target as HTMLElement).closest<HTMLElement>('.tilt-card');if(!card||e.pointerType==='touch')return;const r=card.getBoundingClientRect();card.style.setProperty('--px',`${(e.clientX-r.left)/r.width*100}%`);card.style.setProperty('--py',`${(e.clientY-r.top)/r.height*100}%`)};
  document.addEventListener('pointermove',move,{passive:true});
  return()=>{observer.disconnect();mutation.disconnect();animations.forEach(a=>a.cancel());document.removeEventListener('pointermove',move)};
 },[path]);
 return null;
}
