"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import Link from "./link";
import { LayoutDashboard, ScrollText, Plus, RefreshCw, LoaderCircle, Clock, ShieldCheck, Search, Layers3 } from "./gothic-icon";
import { Sidebar, SidebarProvider, SidebarHeader, SidebarContent, SidebarFooter, SidebarInset, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarGroup, SidebarGroupLabel, SidebarTrigger } from "@/components/ui/sidebar";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { WalletSessionControl } from "./wallet-session-control";
import { AgentManagement } from "./agent-management";
import { getWalletSession, guildhallApi, type ApiCommission, type WalletSession } from "@/lib/guildhall-api";

const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "work", label: "Open commissions", icon: Search },
  { id: "mine", label: "My commissions", icon: ScrollText },
  { id: "agents", label: "My agents", icon: Layers3 },
];
const categories = ["development", "research", "design", "data", "operations", "general"];
const statusLabel: Record<string, string> = {
  open: "Open", funded: "Funded", submitted: "Submitted", approved: "Settling", disputed: "In Tribunal",
  complete: "Complete", refunded: "Refunded", cancelled: "Cancelled", expired: "Expired",
};
const amount = (atomic: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(BigInt(atomic)) / 1_000_000);
const shortWallet = (wallet: string) => `${wallet.slice(0, 5)}…${wallet.slice(-4)}`;
const date = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
const localDateTime = (value: number) => {
  const local = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};
type CommissionSubmission = { id: string; revision: number; submitted_at: string; summary: string; evidence: { kind: string; label: string; value: string }[] };
type FundingInstructions = {
  commissionId: string; cluster: string; assetMint: string; amountAtomic: string; clientWallet: string;
  unsignedTransaction: string; lastValidBlockHeight: number;
};
type PendingFunding = { signature: string; blockhash: string; lastValidBlockHeight: number };

function CommissionCard({
  commission, own = false, onOpen, onAccept, session, asset,
}: {
  commission: ApiCommission; own?: boolean; onOpen: (item: ApiCommission) => void;
  onAccept: (item: ApiCommission) => void; session: WalletSession | null; asset: string;
}) {
  const isClient = session?.walletAddress === commission.clientWallet;
  return <article className="live-commission-card dashboard-panel">
    <header className="live-commission-head">
      <div><span className="eyebrow">{commission.category} · {commission.workType}</span><h2>{commission.title}</h2></div>
      <span className={`status status-${commission.status}`}>{statusLabel[commission.status] ?? commission.status}</span>
    </header>
    <p className="live-commission-description">{commission.description}</p>
    <div className="live-commission-facts">
      <div><span>Budget</span><strong>{amount(commission.amountAtomic)} {asset}</strong></div>
      <div><span>Deadline</span><strong>{date(commission.deadlineAt)}</strong></div>
      <div><span>Provider</span><strong>{commission.providerAgentName ?? (commission.providerWallet ? shortWallet(commission.providerWallet) : "Open to claim")}</strong></div>
    </div>
    <footer>
      <Button variant="ghost" onClick={() => onOpen(commission)}>View details</Button>
      {!own && commission.status === "open" && !isClient && <Button className="button button-gold" onClick={() => onAccept(commission)}>{session ? "Accept work" : "Connect to accept"}</Button>}
      {own && <span className="live-wallet-note">{isClient ? "Posted by you" : "Assigned to you"}</span>}
    </footer>
  </article>;
}

export function LiveDashboard() {
  return <SidebarProvider style={{ "--sidebar-width": "252px" } as React.CSSProperties}><LiveWorkspace /></SidebarProvider>;
}

function LiveWorkspace() {
  const { connection } = useConnection();
  const { connected: walletConnected, publicKey, sendTransaction } = useWallet();
  const [tab, setTab] = useState("overview");
  const [session, setSession] = useState<WalletSession | null>(null);
  const [openJobs, setOpenJobs] = useState<ApiCommission[]>([]);
  const [myJobs, setMyJobs] = useState<ApiCommission[]>([]);
  const [assets, setAssets] = useState<{ USDC: string | null; USDT: string | null; cluster: string }>({ USDC: null, USDT: null, cluster: "devnet" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<ApiCommission | null>(null);
  const [action, setAction] = useState<"submit" | "review" | null>(null);
  const [summary, setSummary] = useState("");
  const [evidence, setEvidence] = useState("");
  const [rationale, setRationale] = useState("");
  const [decision, setDecision] = useState("accept");
  const [form, setForm] = useState({ title: "", description: "", category: "development", amount: "25", asset: "USDC", deadline: localDateTime(Date.now() + 7 * 86_400_000), requiresTribunal: false, safe: false });
  const [submissions, setSubmissions] = useState<CommissionSubmission[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [pendingFunding, setPendingFunding] = useState<{ commissionId: string } & PendingFunding | null>(null);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [nextOpen, nextAssets, nextSession] = await Promise.all([
        guildhallApi<ApiCommission[]>("/commissions?limit=50"),
        guildhallApi<{ USDC: string | null; USDT: string | null; cluster: string }>("/commissions/assets"),
        getWalletSession(),
      ]);
      setOpenJobs(nextOpen);
      setAssets(nextAssets);
      setSession(nextSession);
      setMyJobs(nextSession ? await guildhallApi<ApiCommission[]>("/commissions/mine?limit=100") : []);
    } catch (cause) {
      setError((cause as Error).message || "Could not load live GuildHall data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onSession = (event: Event) => {
      setSession((event as CustomEvent<WalletSession | null>).detail);
      void refresh();
    };
    window.addEventListener("guildhall-session-change", onSession);
    return () => window.removeEventListener("guildhall-session-change", onSession);
  }, [refresh]);

  const visibleOpen = useMemo(() => openJobs.filter((job) => `${job.title} ${job.description} ${job.category}`.toLowerCase().includes(search.toLowerCase())), [openJobs, search]);
  const activeMine = myJobs.filter((job) => !["complete", "refunded", "cancelled", "expired"].includes(job.status));
  const assetName = (commission: ApiCommission) => commission.assetMint === assets.USDT ? "USDT" : "USDC";
  const openCommission = async (commission: ApiCommission) => {
    setDetail(commission);
    setSubmissions([]);
    setSubmissionsLoading(commission.status === "submitted" && session?.walletAddress === commission.clientWallet);
    if (commission.status === "submitted" && session?.walletAddress === commission.clientWallet) {
      try {
        setSubmissions(await guildhallApi<CommissionSubmission[]>(`/commissions/${commission.id}/submissions`));
      } catch (cause) {
        toast.error((cause as Error).message || "Could not load the submitted work.");
      } finally { setSubmissionsLoading(false); }
    }
  };
  const latestSubmission = submissions.at(-1);

  const recordFunding = async (commission: ApiCommission, pending: PendingFunding) => {
    const confirmation = await connection.confirmTransaction({
      signature: pending.signature,
      blockhash: pending.blockhash,
      lastValidBlockHeight: pending.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) throw new Error("The Solana funding transaction failed. The commission is still unfunded.");
    const result = await guildhallApi<{ data: ApiCommission }>(`/commissions/${commission.id}/funding/confirm`, {
      method: "POST",
      body: JSON.stringify({ signature: pending.signature }),
    });
    setPendingFunding(null);
    setDetail(result.data);
    toast.success("Escrow funded and confirmed on Solana.");
    await refresh();
  };

  const fundCommission = async (commission: ApiCommission) => {
    if (!session || !publicKey || !walletConnected || publicKey.toBase58() !== commission.clientWallet || session.walletAddress !== commission.clientWallet) {
      toast.error("Connect the same wallet that posted this commission to fund its escrow.");
      return;
    }
    setFundingBusy(true);
    try {
      const instructions = await guildhallApi<FundingInstructions>(`/commissions/${commission.id}/funding-instructions`);
      if (instructions.commissionId !== commission.id || instructions.clientWallet !== commission.clientWallet || instructions.assetMint !== commission.assetMint || instructions.amountAtomic !== commission.amountAtomic) {
        throw new Error("The funding instructions do not match this commission. No transaction was sent.");
      }
      if (instructions.cluster !== assets.cluster) {
        throw new Error(`This commission is on ${instructions.cluster}, but the dashboard is configured for ${assets.cluster}. No transaction was sent.`);
      }
      const binary = atob(instructions.unsignedTransaction);
      const transaction = Transaction.from(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
      if (!transaction.recentBlockhash) throw new Error("The funding transaction has no recent blockhash. Refresh and try again.");
      const signature = await sendTransaction(transaction, connection);
      const pending = { signature, blockhash: transaction.recentBlockhash, lastValidBlockHeight: instructions.lastValidBlockHeight };
      setPendingFunding({ commissionId: commission.id, ...pending });
      toast.info("Transaction sent. Waiting for Solana confirmation…");
      await recordFunding(commission, pending);
    } catch (cause) {
      console.error("[GuildHall] Commission funding failed:", cause);
      toast.error((cause as Error).message || "Could not fund this commission.");
    } finally { setFundingBusy(false); }
  };

  const confirmPendingFunding = async () => {
    if (!detail || !pendingFunding || pendingFunding.commissionId !== detail.id) return;
    setFundingBusy(true);
    try {
      await recordFunding(detail, pendingFunding);
    } catch (cause) {
      console.error("[GuildHall] Funding confirmation failed:", cause);
      toast.error((cause as Error).message || "The funding transaction is not confirmed yet.");
    } finally { setFundingBusy(false); }
  };

  const createCommission = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) { toast.error("Connect a wallet before posting a commission."); return; }
    if (!form.safe) { toast.error("Confirm the task follows GuildHall’s safety rules."); return; }
    setBusy(true);
    try {
      const created = await guildhallApi<{ data: ApiCommission }>("/commissions", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          category: form.category,
          amount: form.amount,
          asset: form.asset,
          requiresTribunal: form.requiresTribunal,
          deadlineAt: new Date(form.deadline).toISOString(),
          safetyAttestation: true,
        }),
      });
      toast.success("Commission posted. Fund its escrow to make the work available.");
      setCreateOpen(false);
      setForm((current) => ({ ...current, title: "", description: "", safe: false }));
      await refresh();
      setDetail(created.data);
      setTab("mine");
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally { setBusy(false); }
  };

  const acceptWork = async (job: ApiCommission) => {
    if (!session) { toast.error("Connect a wallet before accepting work."); return; }
    setBusy(true);
    try {
      await guildhallApi<ApiCommission>(`/commissions/${job.id}/accept`, { method: "POST", body: JSON.stringify({}) });
      toast.success("Commission accepted. The client must fund it before work begins.");
      await refresh();
    } catch (cause) { toast.error((cause as Error).message); }
    finally { setBusy(false); }
  };

  const submitWork = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      await guildhallApi(`/commissions/${detail.id}/submissions`, {
        method: "POST",
        body: JSON.stringify({ summary, evidence: [{ kind: "text", label: "Work summary", value: evidence }] }),
      });
      toast.success("Encrypted work submission sent to the client.");
      setAction(null); setSummary(""); setEvidence("");
      await refresh();
    } catch (cause) { toast.error((cause as Error).message); }
    finally { setBusy(false); }
  };

  const reviewWork = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      await guildhallApi(`/commissions/${detail.id}/review`, {
        method: "POST", body: JSON.stringify({ decision, rationale }),
      });
      toast.success(decision === "accept"
        ? detail.requiresTribunal ? "Accepted. Tribunal review is underway." : "Accepted. Settlement has started."
        : decision === "dispute" ? "Dispute opened in the Tribunal." : "Changes requested from the provider.");
      setAction(null); setRationale("");
      await refresh();
    } catch (cause) { toast.error((cause as Error).message); }
    finally { setBusy(false); }
  };

  const setSection = (value: string) => { setTab(value); window.scrollTo({ top: 0, behavior: "instant" }); };
  return <>
    <Sidebar className="hall-sidebar"><SidebarHeader><Link href="/" className="dashboard-brand"><img src="/assets/wordmark-transparent.png" alt="GuildHall" /></Link><span className="sandbox-tag">LIVE COMMISSIONS · SOLANA</span></SidebarHeader>
      <SidebarContent><SidebarGroup><SidebarGroupLabel>YOUR HALL</SidebarGroupLabel><SidebarMenu>{navItems.map((item) => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={tab === item.id} onClick={() => setSection(item.id)} size="lg"><item.icon size={20} /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup><SidebarGroup><SidebarGroupLabel>THE PROTOCOL</SidebarGroupLabel><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild size="lg"><Link href="/docs">Documentation</Link></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton asChild size="lg"><Link href="/">Back to GuildHall</Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarGroup></SidebarContent>
      <SidebarFooter><div className="operator-box"><ShieldCheck /><div><strong>Wallet session</strong><span>{session ? shortWallet(session.walletAddress) : "Connect to post or accept"}</span></div></div><WalletSessionControl /></SidebarFooter>
    </Sidebar>
    <SidebarInset className="dashboard-main eerie-dashboard"><div className="hall-ambient" aria-hidden="true"><span>✦</span><div className="hall-grid" /><span>G H _ E S C R O W // G H _ T R I B U N A L</span></div>
      <header className="dashboard-topbar"><div><SidebarTrigger /><span className="mono">GUILDHALL / {tab.toUpperCase()}</span></div><div><span className="sandbox-tag">{assets.cluster.toUpperCase()}</span><Button variant="ghost" size="icon" aria-label="Refresh GuildHall" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></Button></div></header>
      <main className="dashboard-content"><div className="dashboard-title"><div><span className="eyebrow">LIVE SOLANA MARKETPLACE</span><h1>{navItems.find((item) => item.id === tab)?.label ?? "Overview"}</h1><p>{tab === "agents" ? "Register your agents and manage their server runtime credentials." : "Browse real commissions, post paid work, and manage your wallet’s work history."}</p></div>{tab !== "agents" && <Button className="button button-gold" disabled={!session} onClick={() => setCreateOpen(true)}><Plus size={16} />New commission</Button>}</div>
        {!session && <div className="live-connect-banner"><div><strong>Connect a Solana wallet</strong><p>Wallet sign-in creates a GuildHall session. Your signing key stays in your wallet.</p></div><WalletSessionControl /></div>}
        {error && <div className="empty-state error-state"><ShieldCheck /><h2>The Hall could not load</h2><p>{error}</p><Button variant="outline" className="button" onClick={() => void refresh()}>Try again</Button></div>}
        {loading ? <div className="dashboard-loading"><LoaderCircle className="spin" /><p>Loading live commissions…</p></div> : !error && <>
          {tab === "overview" && <><div className="metric-grid three"><div className="metric-card"><ScrollText /><span>Open commissions</span><strong>{openJobs.length}</strong><small>Available in the work board</small></div><div className="metric-card"><Clock /><span>My active work</span><strong>{activeMine.length}</strong><small>Awaiting funding, delivery, or review</small></div><div className="metric-card"><ShieldCheck /><span>Network</span><strong>{assets.cluster}</strong><small>Settlement asset mints configured by GuildHall</small></div></div><section className="dashboard-panel"><div className="panel-heading"><h2>Recently posted work</h2><button className="text-link" onClick={() => setSection("work")}>Browse all</button></div><div className="live-commission-grid">{openJobs.slice(0, 3).map((job) => <CommissionCard key={job.id} commission={job} onOpen={openCommission} onAccept={acceptWork} session={session} asset={assetName(job)} />)}{!openJobs.length && <p className="live-empty">No open commissions have been posted yet.</p>}</div></section></>}
          {tab === "work" && <section className="dashboard-panel"><div className="market-toolbar"><label className="search-field"><Search size={17} /><Input aria-label="Search commissions" placeholder="Search live work" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="mono muted">{visibleOpen.length} OPEN</span></div><div className="live-commission-grid">{visibleOpen.map((job) => <CommissionCard key={job.id} commission={job} onOpen={openCommission} onAccept={acceptWork} session={session} asset={assetName(job)} />)}{!visibleOpen.length && <p className="live-empty">No matching open commissions.</p>}</div></section>}
          {tab === "mine" && <section className="dashboard-panel"><div className="panel-heading"><h2>Wallet commission history</h2><span className="mono muted">{myJobs.length} RECORDS</span></div>{!session ? <p className="live-empty">Connect your wallet to see commissions you posted or accepted.</p> : <div className="live-commission-grid">{myJobs.map((job) => <CommissionCard key={job.id} commission={job} own onOpen={openCommission} onAccept={acceptWork} session={session} asset={assetName(job)} />)}{!myJobs.length && <p className="live-empty">This wallet has no commissions yet.</p>}</div>}</section>}
          {tab === "agents" && <AgentManagement session={session} />}
        </>}
      </main>
    </SidebarInset>
    <Toaster theme="dark" position="bottom-right" />
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="commission-dialog"><DialogTitle>Post a commission</DialogTitle><DialogDescription>Set the work, budget, and deadline. The commission becomes active after escrow funding.</DialogDescription><form className="guild-form" onSubmit={(event) => void createCommission(event)}>
      <div><Label htmlFor="live-title">Title</Label><Input id="live-title" required minLength={3} maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
      <div><Label htmlFor="live-description">Work and acceptance criteria</Label><Textarea id="live-description" required minLength={1} maxLength={5000} rows={5} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
      <div className="form-two"><div><Label>Category</Label><Select value={form.category} onValueChange={(category) => setForm({ ...form, category })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div>
        <div><Label>Asset</Label><Select value={form.asset} onValueChange={(asset) => setForm({ ...form, asset })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(["USDC", "USDT"] as const).filter((asset) => assets[asset]).map((asset) => <SelectItem key={asset} value={asset}>{asset}</SelectItem>)}</SelectContent></Select></div></div>
      <div className="form-two"><div><Label htmlFor="live-amount">Budget</Label><Input id="live-amount" type="number" min="0.01" max="10000" step="0.01" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></div><div><Label htmlFor="live-deadline">Deadline</Label><Input id="live-deadline" type="datetime-local" required min={localDateTime(Date.now() + 60_000)} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></div></div>
      <label className="live-safety-confirm"><input type="checkbox" checked={form.requiresTribunal} onChange={(event) => setForm({ ...form, requiresTribunal: event.target.checked })} /><span>Require independent Tribunal review after I accept the submission. No additional review fee.</span></label>
      <label className="live-safety-confirm"><input type="checkbox" checked={form.safe} onChange={(event) => setForm({ ...form, safe: event.target.checked })} /><span>I confirm this task is lawful and safe, and follows GuildHall’s task rules.</span></label>
      <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy || !form.safe || !assets[form.asset as "USDC" | "USDT"]}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Post commission</Button></div>
    </form></DialogContent></Dialog>
    <Sheet open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setAction(null); setSubmissions([]); } }}><SheetContent className="commission-sheet">{detail && <><span className="eyebrow">{detail.category} / {statusLabel[detail.status] ?? detail.status}</span><SheetTitle>{detail.title}</SheetTitle><SheetDescription>Commission · {amount(detail.amountAtomic)} {assetName(detail)} · due {date(detail.deadlineAt)}</SheetDescription><div className="detail-section"><h3>Work and acceptance criteria</h3><p>{detail.description}</p></div><div className="detail-section"><h3>Parties</h3><div className="mandate-row"><span>Client</span><b>{shortWallet(detail.clientWallet)}</b></div><div className="mandate-row"><span>Provider</span><b>{detail.providerAgentName ?? (detail.providerWallet ? shortWallet(detail.providerWallet) : "Unassigned")}</b></div><div className="mandate-row"><span>Escrow</span><b>{detail.escrowAddress ? shortWallet(detail.escrowAddress) : "Preparing"}</b></div><div className="mandate-row"><span>Funding</span><b>{detail.fundingSignature ? "Confirmed on Solana" : "Awaiting client funding"}</b></div></div>
      {session?.walletAddress === detail.clientWallet && detail.status === "submitted" && <div className="detail-section live-submission">{submissionsLoading ? <p>Loading submitted work…</p> : latestSubmission ? <><h3>Submission · revision {latestSubmission.revision}</h3><p>{latestSubmission.summary}</p>{latestSubmission.evidence.map((item, index) => <div className="live-evidence" key={`${latestSubmission.id}-${index}`}><strong>{item.label || item.kind}</strong><span>{item.value}</span></div>)}</> : <p>Submission details are unavailable. Refresh and try again.</p>}</div>}
      {detail.status === "open" && session?.walletAddress === detail.clientWallet && <div className="detail-section live-funding-panel"><h3>Fund commission escrow</h3><p>This will ask your connected wallet to transfer exactly <strong>{amount(detail.amountAtomic)} {assetName(detail)}</strong> from your wallet to this commission’s escrow on <strong>{assets.cluster}</strong>. Review the amount and token in your wallet before approving.</p>{pendingFunding?.commissionId === detail.id ? <Button className="button button-gold" disabled={fundingBusy} onClick={() => void confirmPendingFunding()}>{fundingBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}Check transaction confirmation</Button> : <Button className="button button-gold" disabled={fundingBusy || !walletConnected || publicKey?.toBase58() !== detail.clientWallet} onClick={() => void fundCommission(detail)}>{fundingBusy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Fund escrow with {assetName(detail)}</Button>}{(!walletConnected || publicKey?.toBase58() !== detail.clientWallet) && <p className="micro-copy">Connect the same wallet that posted this commission to continue.</p>}</div>}
      <div className="detail-actions">{session?.walletAddress === detail.providerWallet && detail.status === "funded" && <Button className="button button-gold" onClick={() => setAction("submit")}>Submit work</Button>}{session?.walletAddress === detail.clientWallet && detail.status === "submitted" && <Button className="button button-gold" disabled={submissionsLoading || !latestSubmission} onClick={() => setAction("review")}>Review submission</Button>}{detail.status === "open" && session?.walletAddress !== detail.clientWallet && <Button className="button button-gold" onClick={() => void acceptWork(detail)}>Accept work</Button>}{!session && <p className="micro-copy">Connect your wallet to claim work or manage this commission.</p>}</div>
      </>}</SheetContent></Sheet>
    <Dialog open={!!action} onOpenChange={(open) => { if (!open) setAction(null); }}><DialogContent className="commission-dialog"><DialogTitle>{action === "submit" ? "Submit work" : "Review submission"}</DialogTitle><DialogDescription>{action === "submit" ? "Your submission is encrypted at rest before the client can review it." : detail?.requiresTribunal ? "Acceptance sends the submission to independent Tribunal review." : "Acceptance starts payment to the provider. Either party can open a Tribunal dispute before approval."}</DialogDescription>{action === "submit" ? <form className="guild-form" onSubmit={(event) => void submitWork(event)}><div><Label htmlFor="work-summary">Summary</Label><Input id="work-summary" required minLength={1} maxLength={5000} value={summary} onChange={(event) => setSummary(event.target.value)} /></div><div><Label htmlFor="work-evidence">Evidence or deliverable URL</Label><Textarea id="work-evidence" required minLength={1} maxLength={4000} rows={4} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></div><div className="form-actions"><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy}>Submit encrypted work</Button></div></form> : <form className="guild-form" onSubmit={(event) => void reviewWork(event)}><div><Label>Decision</Label><Select value={decision} onValueChange={setDecision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="accept">{detail?.requiresTribunal ? "Accept · Tribunal review" : "Accept · release payment"}</SelectItem><SelectItem value="request_changes">Request changes</SelectItem><SelectItem value="dispute">Open Tribunal dispute</SelectItem></SelectContent></Select></div><div><Label htmlFor="review-rationale">Rationale</Label><Textarea id="review-rationale" required minLength={1} maxLength={10000} rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} /></div><div className="form-actions"><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy}>Submit review</Button></div></form>}</DialogContent></Dialog>
  </>;
}
