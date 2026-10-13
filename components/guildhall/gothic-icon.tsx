import type {SVGProps} from 'react';
import artwork from '@/lib/gothic-artwork.json';
type IconProps=SVGProps<SVGSVGElement>&{size?:number|string};

// Small controls use bolder, cut-metal forms; larger emblems retain engraved detail.
const controls:Record<string,string>={
 plus:'M16 1 19 8 18 13 24 12 31 16 24 20 18 19 19 24 16 31 13 24 14 19 8 20 1 16 8 12 14 13 13 8Z',
 check:'M2 17 6 11 12 20 26 4 31 3 28 9 12 30Z',
 copy:'M3 2H20L24 6H7V24H3ZM10 9H25L29 13V30H10ZM13 12V27H26V15H22V12Z',
 arrow:'M1 10 8 13H21L18 7 31 16 18 25 21 19H8L1 22 5 16Z',
 left:'M31 10 24 13H11L14 7 1 16 14 25 11 19H24L31 22 27 16Z',
 down:'M4 8 16 18 28 8 26 18 16 30 6 18Z',
 up:'M4 24 16 14 28 24 26 14 16 2 6 14Z',
 menu:'M2 5 8 2 29 5 25 9 8 8ZM5 14 11 11 30 14 26 18 11 17ZM2 23 8 20 29 23 25 27 8 26Z',
 close:'M2 3 8 4 16 12 24 4 30 3 28 10 20 16 28 23 30 29 24 28 16 20 8 28 2 29 4 23 12 16 4 10Z',
 play:'M7 2 11 5 29 16 11 27 7 30 9 16Z',
 pause:'M5 5 10 1 14 5 12 10V24L14 28 9 31 5 28 7 24V10ZM19 5 24 1 28 5 26 10V24L28 28 23 31 19 28 21 24V10Z',
};
export function GothicIcon({kind='overview',size=32,className='',...props}:IconProps&{kind?:string}){
 const control=controls[kind],emblem=artwork[kind as keyof typeof artwork]||artwork.overview;
 return <svg className={'gothic-icon '+className} data-emblem={kind} viewBox={control?'0 0 32 32':'0 0 512 512'} width={size} height={size} fill="currentColor" stroke="none" aria-hidden="true" {...props}>{control?<path d={control} fillRule="evenodd"/>:emblem.paths.map((d,i)=><path key={i} d={d}/>)}</svg>;
}
export function AgentSigil({category='',identity='',variant,...props}:IconProps&{category?:string;identity?:string;variant?:string}){
 const kind=variant||({ 'RUNE-01':'rune','ASH-02':'agents','ONYX-03':'oracle','HEX-04':'rose','WARD-05':'chains','EMBER-06':'forge'} as Record<string,string>)[identity]||({Development:'rune',Research:'agents',Data:'oracle',Design:'rose',Operations:'chains',Writing:'quill'} as Record<string,string>)[category]||'crest';
 return <GothicIcon kind={kind} {...props} className={'agent-sigil '+(props.className||'')}/>;
}
export function SocialSeal({channel,...props}:IconProps&{channel:string}){return <svg viewBox="0 0 64 64" width="48" height="48" fill="none" aria-hidden="true" {...props}><g stroke="currentColor" strokeWidth=".7"><path d="M32 2 37 8H50L56 14V27L62 32 56 37V50L50 56H37L32 62 27 56H14L8 50V37L2 32 8 27V14L14 8H27Z"/><path d="M12 22V12H22M42 12H52V22M52 42V52H42M22 52H12V42M32 5v8M59 32h-8M32 59v-8M5 32h8"/><path d="M10 10l9 9M54 10l-9 9M54 54l-9-9M10 54l9-9" opacity=".5"/></g><g transform="translate(19 19) scale(1.0833)" fill="currentColor">{channel==='GitHub'?<path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.08c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 1.71 2.62 1.22 3.26.93.1-.73.4-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.08 1.15a10.7 10.7 0 0 1 5.62 0c2.14-1.45 3.08-1.15 3.08-1.15.62 1.55.23 2.7.12 2.98.72.79 1.15 1.8 1.15 3.03 0 4.33-2.63 5.28-5.14 5.56.41.35.77 1.03.77 2.08v3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/>:channel==='Telegram'?<path d="M22.4 2.1 18.9 21c-.26 1.34-1 1.67-2.05 1.03l-5.33-3.93-2.57 2.48c-.28.28-.51.51-1.05.51l.38-5.43L18.15 6c.43-.38-.09-.59-.67-.21L5.28 13.47.03 11.83c-1.14-.36-1.16-1.14.24-1.68L20.8 2.23c.95-.35 1.78.23 1.47 1.58Z"/>:<path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.24l-4.88-7.39L5.62 22H2.5l8.13-9.3L1 2h6.4l4.42 6.73ZM17.86 20h1.73L6.29 3.9H4.43Z"/>}</g></svg>}
const icon=(kind:string)=>function Icon(props:IconProps){return <GothicIcon kind={kind} {...props}/>};
export const LayoutDashboard=icon('overview'),ScrollText=icon('commissions'),ShieldCheck=icon('shield'),Coins=icon('coins'),Wallet=icon('treasury'),Activity=icon('activity'),Plus=icon('plus'),Search=icon('search'),RefreshCw=icon('refresh'),LockKeyhole=icon('lock'),Check=icon('check'),Copy=icon('copy'),LoaderCircle=icon('crown'),BookOpen=icon('docs'),Power=icon('power'),Clock=icon('clock'),FileCheck=icon('filecheck'),Layers3=icon('layers'),CodeXml=icon('code'),CheckCheck=icon('shield'),Scale=icon('tribunal'),Timer=icon('clock'),Database=icon('data'),Zap=icon('bolt'),CircleArrowRight=icon('arrow'),ChevronLeft=icon('left'),ChevronRight=icon('arrow'),Menu=icon('menu'),X=icon('close'),Play=icon('play'),Pause=icon('pause'),Send=icon('arrow');
export const XIcon=X,CheckIcon=Check,ChevronDownIcon=icon('down'),ChevronUpIcon=icon('up'),PanelLeftIcon=Menu;
export const CircleCheckIcon=icon('shield'),InfoIcon=icon('info'),Loader2Icon=icon('crown'),OctagonXIcon=icon('close'),TriangleAlertIcon=icon('warning');
