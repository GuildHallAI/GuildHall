"use client";
import {useEffect,useState,type CSSProperties} from 'react';
import {usePathname} from 'next/navigation';
import {GothicIcon} from './gothic-icon';

type Phase='loading'|'arriving'|'leaving'|'done';
const entrance=(path:string)=>path==='/'||path==='/dashboard';
export function GuildPreloader(){
 const pathname=usePathname();
 const [phase,setPhase]=useState<Phase>('loading');
 const [portal,setPortal]=useState(!entrance(pathname||'/'));
 const [spinOffset,setSpinOffset]=useState(0);
 useEffect(()=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timers:ReturnType<typeof setTimeout>[]=[];
  let disposed=false,finished=false,navigating=false;
  let started=Date.now(),internal=false;
  try{const trip=JSON.parse(sessionStorage.getItem('guildhall-passage')||'null');if(trip?.to===location.pathname&&Date.now()-trip.time<10000){started=trip.time;internal=true;}sessionStorage.removeItem('guildhall-passage')}catch{}
  const isEntrance=entrance(location.pathname);
  setPortal(!isEntrance);setSpinOffset((Date.now()-started)/1000);setPhase('loading');
  const done=()=>{if(!disposed){setPhase('done');navigating=false}};
  const finish=()=>{if(disposed||finished)return;finished=true;setPhase('arriving');timers.push(setTimeout(done,reduced?0:isEntrance?200:240))};
  // Fonts stream independently. Keep the original entrance art without blocking on the whole document.
  const hold=reduced?0:internal?0:isEntrance?650:80;
  timers.push(setTimeout(finish,hold));
  const follow=(event:MouseEvent)=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||navigating)return;
   const anchor=(event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
   if(!anchor||anchor.target==='_blank'||anchor.hasAttribute('download')||anchor.getAttribute('rel')?.includes('external'))return;
   const url=new URL(anchor.href,location.href);
   if(url.origin!==location.origin||url.pathname===location.pathname||!/^https?:$/.test(url.protocol)||/\.[a-z0-9]{2,5}$/i.test(url.pathname))return;
   event.preventDefault();navigating=true;timers.forEach(clearTimeout);
   // The destination owns the visual: home/dashboard never use the inner-page passage.
   setPortal(!entrance(url.pathname));setSpinOffset(0);setPhase('leaving');
   try{sessionStorage.setItem('guildhall-passage',JSON.stringify({to:url.pathname,time:Date.now()}))}catch{}
   timers.push(setTimeout(()=>location.assign(url.href),reduced?0:140));
   timers.push(setTimeout(done,2200));
  };
  const restore=(e:PageTransitionEvent)=>{if(e.persisted)done()};
  document.addEventListener('click',follow);window.addEventListener('pageshow',restore);
  return()=>{disposed=true;timers.forEach(clearTimeout);document.removeEventListener('click',follow);window.removeEventListener('pageshow',restore)};
 },[pathname]);
 useEffect(()=>{
  if(phase==='done')return;
  const root=document.documentElement,content=document.getElementById('guildhall-site'),before=root.style.overflow;
  root.style.overflow='hidden';content?.setAttribute('inert','');
  return()=>{root.style.overflow=before;content?.removeAttribute('inert')};
 },[phase]);
 if(phase==='done')return null;
 return <div className={'guild-preloader '+(portal?'guild-passage':'guild-entrance')} data-phase={phase} role="status" aria-label="Opening GuildHall" style={{'--passage-offset':`${-spinOffset}s`} as CSSProperties}>
  {portal?<div className="passage-apparition" aria-hidden="true"><div className="passage-haze"/><img className="passage-echo" src="/assets/sigil-transparent.png" alt=""/><img className="passage-sigil" src="/assets/sigil-transparent.png" alt=""/><span className="passage-whisper">Beyond the threshold</span></div>:<><div className="guild-preloader-symbols" aria-hidden="true"><img src="/assets/sigil-transparent.png" alt="" className="guild-preloader-symbol"/>{['agents','rose','rune','portal'].map((kind,i)=><GothicIcon key={kind} kind={kind} className="guild-preloader-symbol" style={{'--symbol':i+1} as CSSProperties}/>)}</div><img className="guild-preloader-wordmark" src="/assets/wordmark-transparent.png" alt="" aria-hidden="true"/></>}
  <span className="sr-only">Opening GuildHall</span>
 </div>;
}
