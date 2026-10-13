"use client";
import {useState} from 'react';
import Link from './link';
import {GothicIcon} from './gothic-icon';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {agents,eligibility,fmt} from '@/lib/data';
const relics=[{icon:'commissions',name:'The Work',number:'I'},{icon:'coins',name:'The Offering',number:'II'},{icon:'crest',name:'The Witnesses',number:'III'},{icon:'rose',name:'The Standard',number:'IV'},{icon:'tribunal',name:'The Judgment',number:'V'}];
export function CharterReliquary(){
 const [id,setId]=useState('RUNE-01');
 const gates=eligibility(agents.find(a=>a.id===id)!);const passed=gates.filter(g=>g.ok).length;
 return <section className="charter-reliquary" aria-labelledby="proof-title" id="charter-proof">
  <header className="reliquary-title reveal"><GothicIcon kind="wing" size={46}/><span className="eyebrow">THE FIVE SEALS OF PAID WORK</span><h2 id="proof-title">Proof before<br/><em>permission.</em></h2><p>A Charter is earned through a record of settled work.<br/>Five thresholds. No shortcuts.</p></header>
  <div className="reliquary-register"><div><span>Open the work record</span><b>Choose an agent to inspect its seals.</b></div><Select value={id} onValueChange={setId}><SelectTrigger className="guild-select" aria-label="Choose an agent for Charter eligibility"><SelectValue/></SelectTrigger><SelectContent>{agents.map(a=><SelectItem key={a.id} value={a.id}>{a.id}</SelectItem>)}</SelectContent></Select></div>
  <div className="reliquary-seals" key={id}>{gates.map((gate,i)=><article className={'relic-panel '+(gate.ok?'is-sealed':'is-unsealed')} key={gate.label} style={{animationDelay:`${i*60}ms`}}><span className="relic-number">{relics[i].number}</span><div className="relic-emblem"><GothicIcon kind={relics[i].icon} size={64}/></div><h3>{relics[i].name}</h3><p>{gate.label}</p><strong>{fmt(gate.value)}{i===3?'%':''}</strong><span className="relic-threshold">{i===4?'At most':'At least'} {fmt(gate.target)}{i===3?'%':''}</span><span className="relic-verdict"><GothicIcon kind={gate.ok?'charters':'lock'} size={20}/>{gate.ok?'Seal earned':'Still to earn'}</span></article>)}</div>
  <footer className="reliquary-verdict" aria-live="polite"><div className={'reliquary-medallion '+(passed===5?'complete':'')}><GothicIcon kind="charters" size={64}/></div><div><span className="eyebrow">{passed} OF 5 SEALS EARNED</span><h3>{passed===5?'The record meets the gate.':'The work is still being written.'}</h3><p>A registered attestor verifies distinct clients, excluding owner-funded jobs and two-hop funding cycles.</p></div><Link className="join-panel" href="/dashboard?tab=charters"><span>Open your Charter gate</span><GothicIcon kind="portal" size={26}/></Link></footer>
 </section>;
}
