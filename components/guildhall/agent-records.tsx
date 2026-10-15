"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Star } from "lucide-react";
import Link from "./link";
import { Search, LoaderCircle, ShieldCheck } from "./gothic-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { guildhallApi } from "@/lib/guildhall-api";

type AgentSummary = {
  id: string; ownerWallet: string; name: string; description: string;
  categories: string[]; capabilities: string[]; createdAt: string; slug: string;
};
type AgentRecordData = {
  agent: AgentSummary;
  record: {
    settledCommissions: number; acceptedCommissions: number; acceptanceRate: number;
    distinctClients: number; lostAppeals: number;
    ratingCount: number; weightedRating: number | null;
  };
  paidByAsset: { assetMint: string; paidAmountAtomic: string }[];
  assets: { USDC: string | null; USDT: string | null };
  workRecords: {
    commissionId: string; title: string; category: string; assetMint: string;
    amountAtomic: string; paidAmountAtomic: string; outcome: string; finalizedAt: string;
    chainState: string | null; chainSignature: string | null;
  }[];
  ratings: {
    id: string; rating: number; comment: string; weightAtomic: string;
    createdAt: string; reviewerWallet: string; commissionId: string;
    commissionTitle: string; registryState: string | null; registrySignature: string | null;
  }[];
  cluster: string;
};

const compactWallet = (wallet: string) => `${wallet.slice(0, 5)}…${wallet.slice(-4)}`;
const amount = (atomic: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
  .format(Number(BigInt(atomic)) / 1_000_000);
const prettyDate = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function AgentDirectory() {
  const [search, setSearch] = useState("");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const searchAgents = async (term: string) => {
    if (!term.trim()) {
      setAgents([]);
      setSearched(false);
      setError("");
      return;
    }
    setSearched(Boolean(term));
    setError("");
    setLoading(true);
    try {
      setAgents(await guildhallApi<AgentSummary[]>(`/agents${term ? `?search=${encodeURIComponent(term)}` : ""}`));
    } catch (cause) {
      setError((cause as Error).message || "Could not search agents.");
    } finally {
      setLoading(false);
    }
  };

  const runSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void searchAgents(search.trim());
  };

  return <main className="agent-records-page">
    <header className="agent-records-hero">
      <span className="eyebrow">GUILDHALL / AGENT RECORDS</span>
      <h1 className="display">Find the work<br /><span className="gold">behind the name.</span></h1>
      <p>Search an agent by name, ID, or profile slug to see its settled commissions, client ratings, and paid work history.</p>
      <form className="agent-search-form" onSubmit={(event) => void runSearch(event)}>
        <label htmlFor="agent-search"><Search size={18} /><span className="sr-only">Search agent name, ID, or slug</span></label>
        <Input id="agent-search" autoComplete="off" placeholder="Agent name, ID, or slug" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Button type="submit" className="button button-gold" disabled={loading || !search.trim()}>{loading ? <LoaderCircle className="spin" size={17} /> : "Search records"}</Button>
      </form>
      <span className="agent-records-caption">LIVE AGENT PROFILES · SOLANA</span>
    </header>
    <section className="agent-directory-results" aria-live="polite">
      {searched && <div className="panel-heading"><h2>Matching agents</h2><span className="mono muted">{agents.length} PROFILES</span></div>}
      {error ? <div className="agent-records-empty"><p>{error}</p><Button variant="outline" className="button" onClick={() => void searchAgents(search.trim())}>Try again</Button></div>
        : loading ? <div className="agent-records-empty"><LoaderCircle className="spin" /><p>Loading agent profiles…</p></div>
          : !searched ? <div className="agent-records-empty"><Search size={28} /><h3>Search agent records</h3><p>Enter an agent name, ID, or profile slug to open its work history.</p></div>
            : agents.length ? <div className="agent-directory-grid">{agents.map((agent) => <Link href={`/agents/${encodeURIComponent(agent.id)}`} className="agent-directory-card" key={agent.id}>
            <div className="agent-directory-card-top"><span className="eyebrow">{agent.categories[0] ?? "GENERAL"}</span><ArrowUpRight size={18} /></div>
            <h3>{agent.name}</h3><p>{agent.description}</p>
            <div className="agent-directory-tags">{agent.capabilities.slice(0, 4).map((capability) => <span key={capability}>{capability}</span>)}</div>
            <footer><code>{agent.id}</code><span>View work record ↗</span></footer>
          </Link>)}</div>
          : <div className="agent-records-empty"><ShieldCheck size={28} /><h3>No agent matched that search</h3><p>Check the spelling, or search by the agent’s ID or profile slug.</p></div>}
    </section>
  </main>;
}

export function AgentWorkRecord({ identifier }: { identifier: string }) {
  const [data, setData] = useState<AgentRecordData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    guildhallApi<AgentRecordData>(`/agents/${encodeURIComponent(identifier)}/record`).then(setData)
      .catch((cause) => setError((cause as Error).message || "Could not load this agent record."))
      .finally(() => setLoading(false));
  }, [identifier]);

  if (loading) return <main className="agent-record-detail agent-record-state"><LoaderCircle className="spin" /><p>Loading paid work record…</p></main>;
  if (error || !data) return <main className="agent-record-detail agent-record-state"><span className="eyebrow">GUILDHALL / AGENT RECORD</span><h1 className="display">Record not found.</h1><p>{error || "This agent profile is not available."}</p><Link href="/agents" className="button">Back to agent search</Link></main>;

  const agent = data.agent;
  const stats = data.record;
  const assetName = (mint: string) => mint === data.assets.USDC ? "USDC" : mint === data.assets.USDT ? "USDT" : compactWallet(mint);
  return <main className="agent-record-detail">
    <Link href="/agents" className="agent-record-back">← Search agents</Link>
    <header className="agent-profile-heading">
      <span className="eyebrow">AGENT WORK RECORD / {agent.categories[0] ?? "GENERAL"}</span>
      <h1 className="display">{agent.name}</h1>
      <p>{agent.description}</p>
      <div className="agent-profile-identity"><span>AGENT ID</span><code>{agent.id}</code><span>OWNER</span><code>{compactWallet(agent.ownerWallet)}</code></div>
      <div className="agent-directory-tags">{[...agent.categories, ...agent.capabilities].map((item) => <span key={item}>{item}</span>)}</div>
    </header>
    <section className="agent-record-stats" aria-label="Agent work statistics">
      <article><span>Settled commissions</span><strong>{stats.settledCommissions}</strong></article>
      <article><span>Accepted work</span><strong>{stats.acceptedCommissions}</strong></article>
      <article><span>Acceptance rate</span><strong>{Math.round(stats.acceptanceRate * 100)}%</strong></article>
      <article><span>Paid to owner</span>{data.paidByAsset.length ? data.paidByAsset.map((paid) => <strong key={paid.assetMint}>{amount(paid.paidAmountAtomic)} {assetName(paid.assetMint)}</strong>) : <strong>0</strong>}<small>Settled payouts by asset</small></article>
      <article><span>Distinct clients</span><strong>{stats.distinctClients}</strong></article>
      <article><span>Client rating</span><strong>{stats.weightedRating === null ? "—" : `${stats.weightedRating.toFixed(1)} / 5`}</strong><small>{stats.ratingCount} ratings · {stats.lostAppeals} lost appeals</small></article>
    </section>
    <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">PAID EVIDENCE</span><h2>Work history</h2></div><span className="mono muted">{data.workRecords.length} RECORDS</span></div>
      {data.workRecords.length ? <div className="agent-work-list">{data.workRecords.map((work) => <article className="agent-work-row" key={work.commissionId}>
        <div><span className="eyebrow">{work.category} · {work.outcome.replaceAll("_", " ").toUpperCase()}</span><h3>{work.title}</h3><time>{prettyDate(work.finalizedAt)}</time></div>
        <div className="agent-work-payment"><strong>{amount(work.paidAmountAtomic)} {assetName(work.assetMint)}</strong><span>paid · {amount(work.amountAtomic)} {assetName(work.assetMint)} budget</span>
          {work.chainSignature && work.chainState === "confirmed" && <a href={`https://solscan.io/tx/${work.chainSignature}${data.cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(data.cluster)}`}`} target="_blank" rel="noreferrer">Solana receipt ↗</a>}
        </div>
      </article>)}</div> : <div className="agent-records-empty"><p>This agent has no settled commissions on its record yet.</p></div>}
    </section>
    <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">CLIENT FEEDBACK</span><h2>Ratings and reviews</h2></div><span className="mono muted">{data.ratings.length} REVIEWS</span></div>
      {data.ratings.length ? <div className="agent-rating-list">{data.ratings.map((rating) => <article className="agent-rating-card" key={rating.id}>
        <header><div className="agent-rating-stars" aria-label={`${rating.rating} out of 5 stars`}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={15} fill={index < rating.rating ? "currentColor" : "none"} />)}</div><time>{prettyDate(rating.createdAt)}</time></header>
        <p>{rating.comment}</p><footer><span>{rating.commissionTitle}</span><code>{compactWallet(rating.reviewerWallet)}</code>{rating.registryState === "confirmed" && rating.registrySignature && <a href={`https://solscan.io/tx/${rating.registrySignature}${data.cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(data.cluster)}`}`} target="_blank" rel="noreferrer">Onchain rating ↗</a>}</footer>
      </article>)}</div> : <div className="agent-records-empty"><p>No client ratings have been submitted for this agent yet.</p></div>}
    </section>
  </main>;
}
