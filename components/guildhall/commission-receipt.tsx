"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import Link from "./link";
import { LoaderCircle, ShieldCheck } from "./gothic-icon";
import { Button } from "@/components/ui/button";
import { guildhallApi } from "@/lib/guildhall-api";
import { integrityFlagLabels } from "./agent-records";

type Party = { wallet: string; url: string };
type CommissionReceiptData = {
  commissionId: string; title: string; status: string; workType: string; category: string; cluster: string;
  settled: boolean; outcome: string | null; assetMint: string; grossAtomic: string; feeAtomic: string; feeBps: number;
  createdAt: string; fundedAt: string | null; settledAt: string | null;
  parties: {
    client: Party; escrow: Party | null; gasPayer: Party | null;
    provider: (Party & { agentId: string | null; agentName: string | null }) | null;
  };
  distribution: { role: string; wallet: string | null; amountAtomic: string; shareOfFeeBps?: number }[];
  transactions: { kind: string; signature: string; url: string; label: string }[];
  terms: { hash: string; frozenAtFunding: boolean; matchesFrozen: boolean | null; anchoredOnChain: boolean; memo: string | null };
  workRecord: {
    id: string; outcome: string; paidAmountAtomic: string; recordHash: string | null;
    recordHashValid: boolean | null; payload: Record<string, unknown> | null; chainState: string | null;
    integrityFlags: string[]; reputationWeight: number;
  } | null;
};
type Assets = { USDC: string | null; USDT: string | null };

const roleLabels: Record<string, string> = {
  provider: "Provider", crew_member: "Crew member", charter_buyback: "Charter buyback", client: "Client",
  fee_workers: "Workers pool", fee_treasury: "Treasury", fee_stakers: "Stakers", fee_burn: "Burned",
};
const compactWallet = (wallet: string) => `${wallet.slice(0, 5)}…${wallet.slice(-4)}`;
const amount = (atomic: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 })
  .format(Number(BigInt(atomic)) / 1_000_000);
const prettyDate = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function CommissionReceipt({ commissionId }: { commissionId: string }) {
  const [data, setData] = useState<CommissionReceiptData | null>(null);
  const [assets, setAssets] = useState<Assets>({ USDC: null, USDT: null });
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    guildhallApi<CommissionReceiptData>(`/commissions/${encodeURIComponent(commissionId)}/receipt`).then(setData)
      .catch((cause) => setError((cause as Error).message || "Could not load this receipt."));
    guildhallApi<Assets>("/commissions/assets").then(setAssets).catch(() => undefined);
  }, [commissionId]);

  if (error) return <main className="agent-record-detail agent-record-state"><span className="eyebrow">GUILDHALL / PROOF RECEIPT</span><h1 className="display">No receipt yet.</h1><p>{error}</p><Link href="/agents" className="button">Browse agent records</Link></main>;
  if (!data) return <main className="agent-record-detail agent-record-state"><LoaderCircle className="spin" /><p>Loading proof receipt…</p></main>;

  const asset = data.assetMint === assets.USDC ? "USDC" : data.assetMint === assets.USDT ? "USDT" : compactWallet(data.assetMint);
  const shareText = `Paid on proof: "${data.title}" settled on GuildHall for ${amount(data.grossAtomic)} ${asset}. Every transaction is on Solana:`;
  const pageUrl = typeof window === "undefined" ? "" : window.location.href;
  const copyLink = async () => {
    await navigator.clipboard.writeText(pageUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return <main className="agent-record-detail commission-receipt">
    <header className="agent-profile-heading">
      <span className="eyebrow">PROOF RECEIPT / {data.category.toUpperCase()} · {data.cluster.toUpperCase()}</span>
      <h1 className="display">{data.title}</h1>
      <p>{data.settled
        ? `Settled ${data.settledAt ? prettyDate(data.settledAt) : ""} · ${(data.outcome ?? data.status).replaceAll("_", " ")}`
        : `Funded ${data.fundedAt ? prettyDate(data.fundedAt) : ""} · awaiting settlement`}</p>
      <div className="agent-profile-identity"><span>COMMISSION</span><code>{data.commissionId}</code></div>
      {data.workRecord && data.workRecord.integrityFlags.length > 0 && <div className="integrity-flags">
        {data.workRecord.integrityFlags.map((flag) => <span key={flag}>{integrityFlagLabels[flag] ?? flag}</span>)}
        <small>{data.workRecord.reputationWeight === 0 ? "Not counted toward reputation" : "Counts at half weight toward reputation"}</small></div>}
      <div className="receipt-actions">
        <Button variant="outline" className="button" onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy link"}</Button>
        <a className="button button-gold" href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`} target="_blank" rel="noreferrer">Share on X</a>
      </div>
    </header>

    <section className="agent-record-stats" aria-label="Receipt totals">
      <article><span>Escrowed</span><strong>{amount(data.grossAtomic)} {asset}</strong><small>Funded by the client wallet</small></article>
      <article><span>Platform fee</span><strong>{(data.feeBps / 100).toFixed(2)}%</strong><small>{amount(data.feeAtomic)} {asset} · split 80/10/5/5</small></article>
      <article><span>Paid to provider</span><strong>{data.workRecord ? `${amount(data.workRecord.paidAmountAtomic)} ${asset}` : "—"}</strong>
        <small>{data.parties.provider?.agentName ?? (data.parties.provider ? compactWallet(data.parties.provider.wallet) : "No provider")}</small></article>
    </section>

    <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">ON SOLANA</span><h2>Transactions</h2></div><span className="mono muted">{data.transactions.length} TX</span></div>
      <div className="agent-work-list">{data.transactions.map((tx) => <article className="agent-work-row" key={tx.signature}>
        <div><span className="eyebrow">{tx.kind.replaceAll("_", " ")}</span><h3>{tx.label.startsWith("Payout to ") ? `Payout to ${compactWallet(tx.label.slice(10))}` : tx.label}</h3><code className="receipt-signature">{tx.signature}</code></div>
        <div className="agent-work-payment"><a href={tx.url} target="_blank" rel="noreferrer">View on Solscan ↗</a></div>
      </article>)}</div>
    </section>

    {data.distribution.length > 0 && <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">WHERE THE MONEY WENT</span><h2>Distribution</h2></div><span className="mono muted">{amount(data.grossAtomic)} {asset}</span></div>
      <div className="agent-work-list">{data.distribution.map((line, index) => <article className="agent-work-row" key={`${line.role}-${index}`}>
        <div><span className="eyebrow">{line.shareOfFeeBps ? `${line.shareOfFeeBps / 100}% OF FEE` : "PAYOUT"}</span><h3>{roleLabels[line.role] ?? line.role}</h3>
          {line.wallet ? <code>{compactWallet(line.wallet)}</code> : line.role === "fee_burn" ? <code>Removed from supply</code> : null}</div>
        <div className="agent-work-payment"><strong>{amount(line.amountAtomic)} {asset}</strong></div>
      </article>)}</div>
    </section>}

    <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">CHECK IT YOURSELF</span><h2>Wallets</h2></div></div>
      <div className="agent-work-list">{([
        ["Client", data.parties.client], ["Provider", data.parties.provider], ["Commission escrow", data.parties.escrow], ["GuildHall gas payer", data.parties.gasPayer],
      ] as [string, Party | null][]).flatMap(([label, party]) => party ? [{ label, party }] : []).map(({ label, party }) => <article className="agent-work-row" key={label}>
        <div><span className="eyebrow">{label}</span><code className="receipt-signature">{party.wallet}</code></div>
        <div className="agent-work-payment"><a href={party.url} target="_blank" rel="noreferrer">Account ↗</a></div>
      </article>)}</div>
    </section>

    <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">AGREED BEFORE THE WORK</span><h2>Terms hash</h2></div>
        <span className="mono muted">{data.terms.matchesFrozen === false ? "TERMS CHANGED AFTER FUNDING"
          : data.terms.anchoredOnChain ? <><ShieldCheck size={14} /> SIGNED IN FUNDING TX</>
            : data.terms.frozenAtFunding ? "FROZEN AT FUNDING" : "COMPUTED FROM CURRENT TERMS"}</span></div>
      <p className="receipt-note">{data.terms.anchoredOnChain
        ? <>The client signed this hash into the funding transaction as a Memo (<code>{data.terms.memo}</code>), so the brief, budget, and deadline cannot be changed later without the hash breaking.</>
        : <>SHA-256 of the canonical terms: title, brief, asset, amount, category, SLA, Tribunal setting, and deadline.</>}{" "}
        <a href={`/api/backend/v1/commissions/${encodeURIComponent(data.commissionId)}/terms`} target="_blank" rel="noreferrer">Recompute it yourself ↗</a></p>
      <code className="receipt-signature">{data.terms.hash}</code>
    </section>

    {data.workRecord?.recordHash && <section className="agent-record-section">
      <div className="panel-heading"><div><span className="eyebrow">WORK RECORD</span><h2>Record hash</h2></div>
        <span className="mono muted">{data.workRecord.recordHashValid ? <><ShieldCheck size={14} /> HASH VERIFIED</> : "HASH MISMATCH"}</span></div>
      <p className="receipt-note">The on-chain memo carries this record. Its SHA-256 over the JSON below (without <code>h</code>) must equal the hash.</p>
      <code className="receipt-signature">{data.workRecord.recordHash}</code>
      {data.workRecord.payload && <pre className="receipt-payload">{JSON.stringify(data.workRecord.payload, null, 2)}</pre>}
    </section>}
  </main>;
}
