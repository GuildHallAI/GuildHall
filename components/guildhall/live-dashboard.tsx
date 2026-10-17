"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import Link from "./link";
import { LayoutDashboard, ScrollText, Plus, RefreshCw, LoaderCircle, Clock, ShieldCheck, Search, Layers3 } from "./gothic-icon";
import { Sidebar, SidebarProvider, SidebarHeader, SidebarContent, SidebarFooter, SidebarInset, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarGroup, SidebarGroupLabel, SidebarTrigger } from "@/components/ui/sidebar";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
import { GuildManagement } from "./guild-management";
import { getWalletSession, GuildHallApiError, guildhallApi, type ApiCommission, type WalletSession } from "@/lib/guildhall-api";

const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "work", label: "Open commissions", icon: Search },
  { id: "guild-board", label: "Guild Board", icon: Layers3 },
  { id: "guilds", label: "My Guilds", icon: Layers3 },
  { id: "mine", label: "My commissions", icon: ScrollText },
  { id: "agents", label: "My agents", icon: Layers3 },
];
const categories = ["development", "research", "design", "data", "operations", "general"];
const statusLabel: Record<string, string> = {
  open: "Open", funded: "Funded", submitted: "Submitted", approved: "Settling", disputed: "In Tribunal",
  complete: "Complete", refunded: "Refunded", cancelled: "Taken down", expired: "Expired",
};
function activityLabel(type: string, details: Record<string, unknown>) {
  switch (type) {
    case "posted": return "Commission posted";
    case "funded": return "Escrow funded on Solana";
    case "accepted": return "Provider accepted the commission";
    case "submitted": return `Work submitted${typeof details.revision === "number" ? ` · revision ${details.revision}` : ""}`;
    case "accepted_for_payment": return "Submission accepted by the client";
    case "changes_requested": return "Client requested changes";
    case "disputed": return "Commission entered Tribunal review";
    case "settling": return "Commission settlement is processing";
    case "completed": return "Commission completed and paid";
    case "refunded": return "Commission refunded";
    case "cancelled": return "Commission taken down";
    default: return "Commission status updated";
  }
}
const amount = (atomic: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(BigInt(atomic)) / 1_000_000);
const shortWallet = (wallet: string) => `${wallet.slice(0, 5)}…${wallet.slice(-4)}`;
const date = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
function checkInLabel(lastSeen: string | null, recent: boolean) {
  if (recent) return "Checking in now";
  if (!lastSeen) return "No runtime check-in yet";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60_000));
  return `Last check-in ${new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-minutes, "minute")}`;
}
const localDateTime = (value: number) => {
  const local = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};
type CommissionSubmission = { id: string; revision: number; submitted_at: string; summary: string; evidence: { kind: string; label: string; value: string }[] };
type CommissionActivity = { id: string; type: string; details: Record<string, unknown>; createdAt: string };
type AgentMatch = { id: string; name: string; description: string; categories: string[]; capabilities: string[]; lastRuntimeSeen: string | null; runtimeRecentlyActive: boolean };
type GuildBoardEntry = {
  guildId: string; name: string; description: string; ownerWallet: string; slaHours: number;
  bondTargetAtomic: string; bondConfirmedAtomic: string; memberCount: number;
  members: { walletAddress: string; shareBps: number }[]; settledJobs: number;
  totalPaidAtomic: string; acceptanceRatePercent: number | null;
};
type FundingInstructions = {
  commissionId: string; cluster: string; assetMint: string; amountAtomic: string; clientWallet: string;
  unsignedTransaction: string; lastValidBlockHeight: number; termsHash?: string;
};
type PendingFunding = { signature: string; blockhash: string; lastValidBlockHeight: number; signedTransaction?: string };
const fundingTransactionCanBeDiscarded = (error: unknown) => error instanceof GuildHallApiError
  && ["funding_transaction_mismatch", "funding_transaction_expired", "funding_transaction_failed"].includes(error.code ?? "");
const fundingDiscardMessage = (error: unknown) => {
  if (!(error instanceof GuildHallApiError)) return "";
  if (error.code === "funding_transaction_mismatch") return "The signed transaction was rejected before submission. No funds were moved. Prepare and sign a fresh transaction.";
  if (error.code === "funding_transaction_expired") return "The signed transaction expired before submission. No funds were moved. Prepare and sign a fresh transaction.";
  if (error.code === "funding_transaction_failed") return "Solana rejected the funding transaction, so the token transfer did not complete. Prepare and sign a fresh transaction.";
  return "";
};
const pendingFundingKey = (commissionId: string) => `guildhall:pending-funding:${commissionId}`;
const transactionToBase64 = (transaction: Transaction) => {
  const bytes = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
};

function readPendingFunding(commissionId: string): PendingFunding | null {
  try {
    const raw = localStorage.getItem(pendingFundingKey(commissionId));
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<PendingFunding>;
    if (typeof pending.signature !== "string" || typeof pending.blockhash !== "string"
      || typeof pending.lastValidBlockHeight !== "number"
      || (pending.signedTransaction !== undefined && typeof pending.signedTransaction !== "string")) return null;
    return pending as PendingFunding;
  } catch {
    return null;
  }
}

const markdownSyntax = /(^\s{0,3}#{1,6}\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(\*\*[^\n]+\*\*)|(__[^\n]+__)|(```|~~~)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(^\s*>\s)|(^\s*\|.+\|\s*$)/m;

function MarkdownDeliverable({ value }: { value: string }) {
  if (!markdownSyntax.test(value)) return <p className="deliverable-plain">{value}</p>;
  return <div className="deliverable-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown></div>;
}

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
      {commission.fundingSignature && <Link href={`/receipts/${encodeURIComponent(commission.id)}`} className="button">Proof receipt</Link>}
      {!own && commission.status === "open" && !isClient && <Button className="button button-gold" onClick={() => onAccept(commission)}>{session ? "Accept work" : "Connect to accept"}</Button>}
      {own && <span className="live-wallet-note">{isClient ? "Posted by you" : "Assigned to you"}</span>}
    </footer>
  </article>;
}

function MyCommissionCard({
  commission, session, asset, onOpen,
}: {
  commission: ApiCommission; session: WalletSession; asset: string; onOpen: (item: ApiCommission) => void;
}) {
  const isClient = session.walletAddress === commission.clientWallet;
  const role = isClient ? "You posted this" : "You accepted this";
  let nextAction = "View commission";
  let stage = statusLabel[commission.status] ?? commission.status;
  let context = "Review the latest activity and commission details.";
  if (commission.status === "open" && isClient) {
    nextAction = "Fund escrow";
    stage = "Awaiting your funding";
    context = "Fund the escrow to make this commission available to providers.";
  } else if (commission.status === "open") {
    stage = "Open for a provider";
    context = "Waiting for a provider to accept this commission.";
  } else if (commission.status === "funded" && !isClient) {
    nextAction = "Submit work";
    stage = "Your delivery is due";
    context = "Escrow is funded. Submit your work when it is ready for review.";
  } else if (commission.status === "funded") {
    stage = "Provider is working";
    context = "Escrow is funded and the provider is working on the commission.";
  } else if (commission.status === "submitted" && isClient) {
    nextAction = "Review submission";
    stage = "Your review is needed";
    context = "The provider submitted work. Review it to request changes, accept, or dispute.";
  } else if (commission.status === "submitted") {
    stage = "Awaiting client review";
    context = "Your submission is with the client for review.";
  } else if (commission.status === "approved") {
    stage = "Settlement processing";
    context = "The client accepted the submission and payout is processing.";
  } else if (commission.status === "disputed") {
    stage = "Tribunal review";
    context = "This commission is in Tribunal review.";
  } else if (commission.status === "complete") {
    stage = "Completed and paid";
    context = "The commission is complete and its payout has settled.";
  } else if (commission.status === "refunded") {
    stage = "Refunded";
    context = "Escrow has been returned to the client.";
  } else if (commission.status === "cancelled" || commission.status === "expired") {
    context = "This commission is no longer active.";
  }
  const counterparty = isClient
    ? commission.providerAgentName ?? (commission.providerWallet ? shortWallet(commission.providerWallet) : "Waiting for provider")
    : shortWallet(commission.clientWallet);
  const updatedAt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(commission.updatedAt));

  return <article className="live-commission-card dashboard-panel my-commission-card">
    <header className="live-commission-head">
      <div><span className="eyebrow">{commission.category} · {commission.workType} · {role}</span><h2>{commission.title}</h2></div>
      <span className={`status status-${commission.status}`}>{statusLabel[commission.status] ?? commission.status}</span>
    </header>
    <div className="live-commission-facts">
      <div><span>Budget</span><strong>{amount(commission.amountAtomic)} {asset}</strong></div>
      <div><span>Deadline</span><strong>{date(commission.deadlineAt)}</strong></div>
      <div><span>{isClient ? "Provider" : "Client"}</span><strong>{counterparty}</strong></div>
    </div>
    <div className="my-commission-progress"><div><span className="eyebrow">CURRENT STEP</span><strong>{stage}</strong><p>{context}</p></div><time dateTime={commission.updatedAt}>Updated {updatedAt}</time></div>
    <footer><Button className={nextAction !== "View commission" ? "button button-gold" : undefined} variant={nextAction !== "View commission" ? undefined : "ghost"} onClick={() => onOpen(commission)}>{nextAction}</Button>{commission.fundingSignature && <Link href={`/receipts/${encodeURIComponent(commission.id)}`} className="button">Proof receipt</Link>}</footer>
  </article>;
}

export function LiveDashboard() {
  return <SidebarProvider style={{ "--sidebar-width": "252px" } as React.CSSProperties}><LiveWorkspace /></SidebarProvider>;
}

function LiveWorkspace() {
  const { connected: walletConnected, publicKey, signTransaction } = useWallet();
  const [tab, setTab] = useState("overview");
  const [session, setSession] = useState<WalletSession | null>(null);
  const [openJobs, setOpenJobs] = useState<ApiCommission[]>([]);
  const [myJobs, setMyJobs] = useState<ApiCommission[]>([]);
  const [guildBoard, setGuildBoard] = useState<GuildBoardEntry[]>([]);
  const [agentMatches, setAgentMatches] = useState<AgentMatch[]>([]);
  const [agentMatchesLoading, setAgentMatchesLoading] = useState(false);
  const [agentMatchesError, setAgentMatchesError] = useState("");
  const [assets, setAssets] = useState<{ USDC: string | null; USDT: string | null; cluster: string }>({ USDC: null, USDT: null, cluster: "devnet" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [assetFilter, setAssetFilter] = useState("all");
  const [minimumBudget, setMinimumBudget] = useState("");
  const [maximumBudget, setMaximumBudget] = useState("");
  const [deadlineFilter, setDeadlineFilter] = useState("all");
  const [tribunalFilter, setTribunalFilter] = useState("all");
  const [sortOpenJobs, setSortOpenJobs] = useState("newest");
  const [createOpen, setCreateOpen] = useState(false);
  const [guildToHire, setGuildToHire] = useState<GuildBoardEntry | null>(null);
  const [guildSearch, setGuildSearch] = useState("");
  const [guildWorkForm, setGuildWorkForm] = useState({ title: "", description: "", category: "operations", amount: "25", asset: "USDC", safe: false });
  const [guildTasks, setGuildTasks] = useState<Record<string, { title: string; description: string }>>({});
  const [detail, setDetail] = useState<ApiCommission | null>(null);
  const [action, setAction] = useState<"submit" | "review" | null>(null);
  const [summary, setSummary] = useState("");
  const [evidence, setEvidence] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [rationale, setRationale] = useState("");
  const [decision, setDecision] = useState("accept");
  const [form, setForm] = useState({ title: "", description: "", category: "development", amount: "25", asset: "USDC", deadline: localDateTime(Date.now() + 7 * 86_400_000), requiresTribunal: false, safe: false });
  const [submissions, setSubmissions] = useState<CommissionSubmission[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [activity, setActivity] = useState<CommissionActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [fundingBusy, setFundingBusy] = useState(false);
  const [pendingFunding, setPendingFunding] = useState<{ commissionId: string } & PendingFunding | null>(null);
  const fundingLock = useRef(false);
  const [takeDownOpen, setTakeDownOpen] = useState(false);
  const [takingDown, setTakingDown] = useState(false);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);

  useEffect(() => {
    const urls = imageFiles.map((file) => URL.createObjectURL(file));
    setImagePreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [imageFiles]);

  useEffect(() => {
    if (!session) return;
    for (const commission of myJobs) {
      const key = pendingFundingKey(commission.id);
      if (commission.status !== "open") {
        localStorage.removeItem(key);
        continue;
      }
      if (commission.clientWallet !== session.walletAddress || pendingFunding?.commissionId === commission.id) continue;
      const pending = readPendingFunding(commission.id);
      if (pending) setPendingFunding({ commissionId: commission.id, ...pending });
    }
  }, [myJobs, session?.walletAddress, pendingFunding?.commissionId]);

  useEffect(() => {
    if (!detail) return;
    const refreshed = myJobs.find((commission) => commission.id === detail.id);
    if (refreshed && refreshed.updatedAt !== detail.updatedAt) setDetail(refreshed);
  }, [detail, myJobs]);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [nextOpen, nextAssets, nextSession, nextGuildBoard] = await Promise.all([
        guildhallApi<ApiCommission[]>("/commissions?limit=50"),
        guildhallApi<{ USDC: string | null; USDT: string | null; cluster: string }>("/commissions/assets"),
        getWalletSession(),
        guildhallApi<GuildBoardEntry[]>("/guilds/board"),
      ]);
      setOpenJobs(nextOpen);
      setAssets(nextAssets);
      setGuildBoard(nextGuildBoard);
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
    const refreshTimer = window.setInterval(() => void refresh(), 30_000);
    const onSession = (event: Event) => {
      setSession((event as CustomEvent<WalletSession | null>).detail);
      void refresh();
    };
    window.addEventListener("guildhall-session-change", onSession);
    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener("guildhall-session-change", onSession);
    };
  }, [refresh]);

  const loadActivity = useCallback(async (commissionId: string) => {
    try {
      const result = await guildhallApi<CommissionActivity[]>(`/commissions/${commissionId}/activity`);
      setActivity(result);
      setActivityError("");
    } catch (cause) {
      setActivityError((cause as Error).message || "Could not load commission activity.");
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detail) return;
    if (!session) {
      setActivity([]);
      setActivityLoading(false);
      return;
    }
    setActivity([]);
    setActivityError("");
    setActivityLoading(true);
    void loadActivity(detail.id);
    const timer = window.setInterval(() => void loadActivity(detail.id), 30_000);
    return () => window.clearInterval(timer);
  }, [detail?.id, session?.userId, loadActivity]);

  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    setAgentMatchesLoading(true);
    setAgentMatchesError("");
    guildhallApi<AgentMatch[]>(`/agents?category=${encodeURIComponent(form.category)}`)
      .then((matches) => { if (!cancelled) setAgentMatches(matches.slice(0, 5)); })
      .catch((cause) => { if (!cancelled) setAgentMatchesError((cause as Error).message || "Could not load agent matches."); })
      .finally(() => { if (!cancelled) setAgentMatchesLoading(false); });
    return () => { cancelled = true; };
  }, [createOpen, form.category]);

  const assetName = (commission: ApiCommission) => commission.assetMint === assets.USDT ? "USDT" : "USDC";
  const categoryOptions = useMemo(() => [...new Set(openJobs.map((job) => job.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [openJobs]);
  const visibleOpen = useMemo(() => {
    const parseBudget = (value: string) => {
      const normalized = value.trim();
      if (!normalized) return null;
      if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) return null;
      const [whole, fraction = ""] = normalized.split(".");
      return BigInt(whole) * BigInt(1_000_000) + BigInt((fraction + "000000").slice(0, 6));
    };
    const min = parseBudget(minimumBudget);
    const max = parseBudget(maximumBudget);
    const cutoff = deadlineFilter === "all" ? null : Date.now() + Number(deadlineFilter) * 86_400_000;
    const matching = openJobs.filter((job) => {
      if (!`${job.title} ${job.description} ${job.category}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter !== "all" && job.category !== categoryFilter) return false;
      if (assetFilter !== "all" && assetName(job) !== assetFilter) return false;
      const budget = BigInt(job.amountAtomic);
      if (min !== null && budget < min) return false;
      if (max !== null && budget > max) return false;
      if (cutoff !== null && new Date(job.deadlineAt).getTime() > cutoff) return false;
      if (tribunalFilter === "required" && !job.requiresTribunal) return false;
      if (tribunalFilter === "optional" && job.requiresTribunal) return false;
      return true;
    });
    return matching.sort((a, b) => {
      if (sortOpenJobs === "payout") return BigInt(b.amountAtomic) > BigInt(a.amountAtomic) ? 1 : BigInt(b.amountAtomic) < BigInt(a.amountAtomic) ? -1 : 0;
      if (sortOpenJobs === "deadline") return new Date(a.deadlineAt).getTime() - new Date(b.deadlineAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [openJobs, search, categoryFilter, assetFilter, minimumBudget, maximumBudget, deadlineFilter, tribunalFilter, sortOpenJobs, assets.USDT]);
  const filtersActive = search !== "" || categoryFilter !== "all" || assetFilter !== "all" || minimumBudget !== "" || maximumBudget !== "" || deadlineFilter !== "all" || tribunalFilter !== "all" || sortOpenJobs !== "newest";
  const activeMine = myJobs.filter((job) => !["complete", "refunded", "cancelled", "expired"].includes(job.status));
  const recentMine = useMemo(() => [...myJobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [myJobs]);
  const needsAttention = myJobs.flatMap((job) => {
    if (!session) return [];
    if (session.walletAddress === job.clientWallet && job.status === "open") return [{ job, action: "Fund escrow" }];
    if (session.walletAddress === job.clientWallet && job.status === "submitted") return [{ job, action: "Review submission" }];
    if (session.walletAddress === job.providerWallet && job.status === "funded") return [{ job, action: "Submit work" }];
    return [];
  });
  const openCommission = async (commission: ApiCommission) => {
    setDetail(commission);
    setSubmissions([]);
    setActivity([]);
    setActivityError("");
    const isClient = session?.walletAddress === commission.clientWallet;
    setSubmissionsLoading(Boolean(isClient));
    if (isClient) {
      try {
        setSubmissions(await guildhallApi<CommissionSubmission[]>(`/commissions/${commission.id}/submissions`));
      } catch (cause) {
        toast.error((cause as Error).message || "Could not load the submitted work.");
      } finally { setSubmissionsLoading(false); }
    }
  };
  const latestSubmission = submissions.at(-1);

  const recordFunding = async (commission: ApiCommission, pending: PendingFunding) => {
    const result = await guildhallApi<ApiCommission>(`/commissions/${commission.id}/funding/confirm`, {
      method: "POST",
      body: JSON.stringify({ signature: pending.signature }),
    });
    localStorage.removeItem(pendingFundingKey(commission.id));
    setPendingFunding(null);
    setDetail(result);
    toast.success("Escrow funded and confirmed on Solana.");
    await refresh();
  };

  const fundCommission = async (commission: ApiCommission) => {
    if (fundingLock.current) return;
    if (!session || !publicKey || !walletConnected || publicKey.toBase58() !== commission.clientWallet || session.walletAddress !== commission.clientWallet) {
      toast.error("Connect the same wallet that posted this commission to fund its escrow.");
      return;
    }
    fundingLock.current = true;
    setFundingBusy(true);
    let sentSignature: string | null = null;
    try {
      const instructions = await guildhallApi<FundingInstructions>(`/commissions/${commission.id}/funding-instructions`, { method: "POST", body: JSON.stringify({}) });
      if (instructions.commissionId !== commission.id || instructions.clientWallet !== commission.clientWallet || instructions.assetMint !== commission.assetMint || instructions.amountAtomic !== commission.amountAtomic) {
        throw new Error("The funding instructions do not match this commission. No transaction was sent.");
      }
      if (instructions.cluster !== assets.cluster) {
        throw new Error(`This commission is on ${instructions.cluster}, but the dashboard is configured for ${assets.cluster}. No transaction was sent.`);
      }
      const binary = atob(instructions.unsignedTransaction);
      const transaction = Transaction.from(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
      if (!transaction.recentBlockhash) throw new Error("The funding transaction has no recent blockhash. Refresh and try again.");
      if (!signTransaction) throw new Error("The connected wallet cannot sign this funding transaction.");
      const signedTransaction = await signTransaction(transaction);
      if (!signedTransaction.signature) throw new Error("The wallet did not return a transaction signature.");
      const signature = bs58.encode(signedTransaction.signature);
      sentSignature = signature;
      const signedTransactionBase64 = transactionToBase64(signedTransaction);
      const pending = { signature, blockhash: transaction.recentBlockhash, lastValidBlockHeight: instructions.lastValidBlockHeight, signedTransaction: signedTransactionBase64 };
      setPendingFunding({ commissionId: commission.id, ...pending });
      try { localStorage.setItem(pendingFundingKey(commission.id), JSON.stringify(pending)); } catch { /* Keep the in-memory retry available. */ }
      toast.info(instructions.termsHash
        ? `Transaction signed with terms hash ${instructions.termsHash.slice(0, 10)}…. GuildHall is submitting it to Solana…`
        : "Transaction signed. GuildHall is submitting it to Solana…");
      const submitted = await guildhallApi<{ signature: string }>(`/commissions/${commission.id}/funding/submit`, {
        method: "POST",
        body: JSON.stringify({ signedTransaction: signedTransactionBase64 }),
      });
      if (submitted.signature !== signature) throw new Error("GuildHall returned a different signature for the signed transaction.");
      await recordFunding(commission, pending);
    } catch (cause) {
      console.error("[GuildHall] Commission funding failed:", cause);
      if (fundingTransactionCanBeDiscarded(cause)) {
        localStorage.removeItem(pendingFundingKey(commission.id));
        setPendingFunding(null);
      }
      toast.error(fundingDiscardMessage(cause) || (sentSignature
          ? "Your transaction is signed. GuildHall may still be submitting it. Do not sign another funding transaction; use Check transaction confirmation to retry."
          : (cause as Error).message || "Could not fund this commission."));
    } finally { fundingLock.current = false; setFundingBusy(false); }
  };

  const confirmPendingFunding = async () => {
    if (!detail || !pendingFunding || pendingFunding.commissionId !== detail.id) return;
    if (fundingLock.current) return;
    fundingLock.current = true;
    setFundingBusy(true);
    try {
      if (pendingFunding.signedTransaction) {
        await guildhallApi<{ signature: string }>(`/commissions/${detail.id}/funding/submit`, {
          method: "POST",
          body: JSON.stringify({ signedTransaction: pendingFunding.signedTransaction }),
        });
      }
      await recordFunding(detail, pendingFunding);
    } catch (cause) {
      console.error("[GuildHall] Funding confirmation failed:", cause);
      if (fundingTransactionCanBeDiscarded(cause)) {
        localStorage.removeItem(pendingFundingKey(detail.id));
        setPendingFunding(null);
      }
      toast.error(fundingDiscardMessage(cause) || (cause as Error).message || "The funding transaction is not confirmed yet.");
    } finally { fundingLock.current = false; setFundingBusy(false); }
  };

  const takeDownCommission = async () => {
    if (!detail || !session || session.walletAddress !== detail.clientWallet) return;
    if (pendingFunding?.commissionId === detail.id) {
      toast.error("Check the funding transaction first. It may still confirm on Solana.");
      setTakeDownOpen(false);
      return;
    }
    setTakingDown(true);
    try {
      await guildhallApi<{ data: { id: string; status: string } }>(`/commissions/${detail.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setDetail({ ...detail, status: "cancelled" });
      setTakeDownOpen(false);
      toast.success("Commission taken down from the open work board.");
      await refresh();
    } catch (cause) {
      toast.error((cause as Error).message || "Could not take down this commission.");
    } finally {
      setTakingDown(false);
    }
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

  const hireGuild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !guildToHire) { toast.error("Connect a wallet before commissioning a Guild."); return; }
    if (!guildWorkForm.safe) { toast.error("Confirm the work follows GuildHall’s task rules."); return; }
    const paidMembers = guildToHire.members.filter((member) => member.shareBps > 0);
    const tasks = paidMembers.map((member) => ({ walletAddress: member.walletAddress, ...guildTasks[member.walletAddress] }));
    if (tasks.some((task) => !task.title?.trim() || !task.description?.trim())) {
      toast.error("Add a task and delivery criteria for every paid Guild member.");
      return;
    }
    setBusy(true);
    try {
      const created = await guildhallApi<{ commissionId: string }>(`/guilds/${guildToHire.guildId}/commissions`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title: guildWorkForm.title,
          description: guildWorkForm.description,
          asset: guildWorkForm.asset,
          amount: guildWorkForm.amount,
          category: guildWorkForm.category,
          tasks,
          safetyAttestation: true,
        }),
      });
      toast.success("Guild commission posted. Fund its escrow to start the work.");
      setGuildToHire(null);
      setGuildWorkForm({ title: "", description: "", category: "operations", amount: "25", asset: "USDC", safe: false });
      setGuildTasks({});
      setTab("mine");
      await refresh();
      const mine = await guildhallApi<ApiCommission[]>("/commissions/mine?limit=100");
      const createdCommission = mine.find((commission) => commission.id === created.commissionId);
      if (createdCommission) await openCommission(createdCommission);
    } catch (cause) {
      toast.error((cause as Error).message || "Could not create the Guild commission.");
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
    const stagedImageIds: string[] = [];
    try {
      const imageEvidence = [] as { kind: "image"; label: string; value: string }[];
      for (const file of imageFiles) {
        const uploaded = await guildhallApi<{ id: string }>(`/commissions/${detail.id}/submission-assets`, {
          method: "POST",
          headers: { "content-type": file.type },
          body: file,
        });
        stagedImageIds.push(uploaded.id);
        imageEvidence.push({ kind: "image", label: file.name, value: uploaded.id });
      }
      const submissionEvidence = [
        ...(evidence.trim() ? [{ kind: "text", label: "Work summary", value: evidence }] : []),
        ...imageEvidence,
      ];
      await guildhallApi(`/commissions/${detail.id}/submissions`, {
        method: "POST",
        body: JSON.stringify({ summary, evidence: submissionEvidence }),
      });
      toast.success("Encrypted work submission sent to the client.");
      setAction(null); setSummary(""); setEvidence(""); setImageFiles([]);
      await refresh();
    } catch (cause) {
      await Promise.all(stagedImageIds.map((assetId) => guildhallApi(`/commissions/${detail.id}/submission-assets/${assetId}`, { method: "DELETE" }).catch(() => undefined)));
      toast.error((cause as Error).message);
    }
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
      <main className="dashboard-content"><div className="dashboard-title"><div><span className="eyebrow">LIVE SOLANA MARKETPLACE</span><h1>{navItems.find((item) => item.id === tab)?.label ?? "Overview"}</h1><p>{tab === "agents" ? "Register your agents and manage their server runtime credentials." : tab === "guilds" ? "Form a team, set its payout plan, and manage the shared Guild bond." : "Browse real commissions, post paid work, and manage your wallet’s work history."}</p></div>{!(["agents", "guilds"].includes(tab)) && <Button className="button button-gold" disabled={!session} onClick={() => setCreateOpen(true)}><Plus size={16} />New commission</Button>}</div>
        {!session && <div className="live-connect-banner"><div><strong>Connect a Solana wallet</strong><p>Wallet sign-in creates a GuildHall session. Your signing key stays in your wallet.</p></div><WalletSessionControl /></div>}
        {error && <div className="empty-state error-state"><ShieldCheck /><h2>The Hall could not load</h2><p>{error}</p><Button variant="outline" className="button" onClick={() => void refresh()}>Try again</Button></div>}
        {loading ? <div className="dashboard-loading"><LoaderCircle className="spin" /><p>Loading live commissions…</p></div> : !error && <>
          {tab === "overview" && <><div className="metric-grid three"><div className="metric-card"><ScrollText /><span>Open commissions</span><strong>{openJobs.length}</strong><small>Available in the work board</small></div><div className="metric-card"><Clock /><span>My active work</span><strong>{activeMine.length}</strong><small>Awaiting funding, delivery, or review</small></div><div className="metric-card"><ShieldCheck /><span>Network</span><strong>{assets.cluster}</strong><small>Settlement asset mints configured by GuildHall</small></div></div>{session && <section className="dashboard-panel activity-attention"><div className="panel-heading"><h2>Needs your attention</h2><span className="mono muted">UPDATES EVERY 30 SECONDS</span></div>{needsAttention.length ? <div className="attention-list">{needsAttention.slice(0, 6).map(({ job, action }) => <button className="attention-row" key={`${job.id}-${action}`} onClick={() => void openCommission(job)}><span><strong>{action}</strong><small>{job.title}</small></span><span className="attention-arrow">View →</span></button>)}</div> : <p className="live-empty">Nothing needs your attention right now.</p>}</section>}<section className="dashboard-panel"><div className="panel-heading"><h2>Recently posted work</h2><button className="text-link" onClick={() => setSection("work")}>Browse all</button></div><div className="live-commission-grid">{openJobs.slice(0, 3).map((job) => <CommissionCard key={job.id} commission={job} onOpen={openCommission} onAccept={acceptWork} session={session} asset={assetName(job)} />)}{!openJobs.length && <p className="live-empty">No open commissions have been posted yet.</p>}</div></section></>}
          {tab === "work" && <section className="dashboard-panel"><div className="market-toolbar"><div className="market-search-row"><label className="search-field"><Search size={17} /><Input aria-label="Search commissions" placeholder="Search live work" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="mono muted">{visibleOpen.length} / {openJobs.length} OPEN</span></div><div className="market-filters" aria-label="Filter open commissions">
            <label className="market-filter"><span>Category</span><Select value={categoryFilter} onValueChange={setCategoryFilter}><SelectTrigger className="guild-select" aria-label="Filter by category"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All categories</SelectItem>{categoryOptions.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></label>
            <label className="market-filter"><span>Token</span><Select value={assetFilter} onValueChange={setAssetFilter}><SelectTrigger className="guild-select" aria-label="Filter by token"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All tokens</SelectItem><SelectItem value="USDC">USDC</SelectItem><SelectItem value="USDT">USDT</SelectItem></SelectContent></Select></label>
            <div className="market-filter"><span>Budget range · USD</span><div className="market-budget-range"><Input aria-label="Minimum payout" type="number" min="0" step="0.000001" placeholder="Min" value={minimumBudget} onChange={(event) => setMinimumBudget(event.target.value)} /><Input aria-label="Maximum payout" type="number" min="0" step="0.000001" placeholder="Max" value={maximumBudget} onChange={(event) => setMaximumBudget(event.target.value)} /></div></div>
            <label className="market-filter"><span>Deadline</span><Select value={deadlineFilter} onValueChange={setDeadlineFilter}><SelectTrigger className="guild-select" aria-label="Filter by deadline"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any deadline</SelectItem><SelectItem value="1">Due within 24 hours</SelectItem><SelectItem value="7">Due within 7 days</SelectItem><SelectItem value="30">Due within 30 days</SelectItem></SelectContent></Select></label>
            <label className="market-filter"><span>Tribunal</span><Select value={tribunalFilter} onValueChange={setTribunalFilter}><SelectTrigger className="guild-select" aria-label="Filter by Tribunal requirement"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any review path</SelectItem><SelectItem value="required">Tribunal required</SelectItem><SelectItem value="optional">No Tribunal required</SelectItem></SelectContent></Select></label>
            <label className="market-filter"><span>Sort by</span><Select value={sortOpenJobs} onValueChange={setSortOpenJobs}><SelectTrigger className="guild-select" aria-label="Sort commissions"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="newest">Newest</SelectItem><SelectItem value="payout">Highest payout</SelectItem><SelectItem value="deadline">Soonest due</SelectItem></SelectContent></Select></label>
            {filtersActive && <Button className="market-clear-filters" variant="ghost" onClick={() => { setSearch(""); setCategoryFilter("all"); setAssetFilter("all"); setMinimumBudget(""); setMaximumBudget(""); setDeadlineFilter("all"); setTribunalFilter("all"); setSortOpenJobs("newest"); }}>Clear filters</Button>}
          </div></div><div className="live-commission-grid">{visibleOpen.map((job) => <CommissionCard key={job.id} commission={job} onOpen={openCommission} onAccept={acceptWork} session={session} asset={assetName(job)} />)}{!visibleOpen.length && <p className="live-empty">No matching open commissions.</p>}</div></section>}
          {tab === "guild-board" && <section className="dashboard-panel">
            <div className="panel-heading"><div><h2>Guilds taking work</h2><p className="my-commission-intro">Bonded teams with a shared service record. Hire a Guild for one commission; escrow and payout follow the standard GuildHall flow.</p></div><span className="mono muted">{guildBoard.length} ACTIVE</span></div>
            <div className="market-toolbar"><label className="search-field"><Search size={17}/><Input aria-label="Search Guild Board" placeholder="Search Guilds and capabilities" value={guildSearch} onChange={(event) => setGuildSearch(event.target.value)}/></label><span className="mono muted">RANKED BY SETTLED WORK</span></div>
            <div className="guild-board-grid">{guildBoard.filter((guild) => `${guild.name} ${guild.description}`.toLowerCase().includes(guildSearch.toLowerCase())).map((guild) => {
              const isMember = session && guild.members.some((member) => member.walletAddress === session.walletAddress);
              const shareTotal = guild.members.reduce((sum, member) => sum + member.shareBps, 0);
              return <article className="guild-board-card" key={guild.guildId}>
                <header><span className="agent-glyph"><Layers3 size={22}/></span><div><h3>{guild.name}</h3><span>Bonded Guild · {guild.memberCount} paid member{guild.memberCount === 1 ? "" : "s"}</span></div><span className="status status-complete">TAKING WORK</span></header>
                <p>{guild.description}</p>
                <div className="guild-board-metrics"><div><b>{guild.settledJobs}</b><small>settled Guild jobs</small></div><div><b>{guild.acceptanceRatePercent === null ? "—" : `${guild.acceptanceRatePercent.toFixed(0)}%`}</b><small>acceptance rate</small></div><div><b>{amount(guild.totalPaidAtomic)} USDC</b><small>paid through GuildHall</small></div><div><b>{guild.slaHours}h</b><small>service SLA</small></div></div>
                <div className="guild-board-roster"><span className="eyebrow">PAYOUT SHARES</span>{guild.members.map((member) => <span key={member.walletAddress}>{shortWallet(member.walletAddress)} <b>{(member.shareBps / 100).toFixed(0)}%</b></span>)}{shareTotal !== 10000 && <small>Guild lead is completing its payout plan.</small>}</div>
                <footer><span className="mono muted">Bond {amount(guild.bondConfirmedAtomic)} / {amount(guild.bondTargetAtomic)} USDC</span><Button className="button button-gold" disabled={!session || busy || Boolean(isMember) || shareTotal !== 10000} onClick={() => { setGuildWorkForm({ title: "", description: "", category: "operations", amount: "25", asset: assets.USDC ? "USDC" : "USDT", safe: false }); setGuildTasks(Object.fromEntries(guild.members.filter((member) => member.shareBps > 0).map((member) => [member.walletAddress, { title: "", description: "" }]))); setGuildToHire(guild); }}>{!session ? "Connect to hire" : isMember ? "Your Guild" : shareTotal !== 10000 ? "Payout plan incomplete" : "Commission this Guild"}</Button></footer>
              </article>;
            })}{!guildBoard.length && <div className="empty-state"><h2>No Guilds on the Board yet</h2><p>Guild listings appear here after their shared bond is funded and member payout shares are set.</p></div>}{guildBoard.length > 0 && !guildBoard.some((guild) => `${guild.name} ${guild.description}`.toLowerCase().includes(guildSearch.toLowerCase())) && <p className="live-empty">No Guilds match that search.</p>}</div>
          </section>}
          {tab === "mine" && <><div className="metric-grid three my-commission-metrics"><div className="metric-card"><Clock /><span>Active commissions</span><strong>{activeMine.length}</strong><small>Work still moving through the process</small></div><div className="metric-card"><ShieldCheck /><span>Needs your action</span><strong>{needsAttention.length}</strong><small>Funding, delivery, or review</small></div><div className="metric-card"><ScrollText /><span>Completed</span><strong>{myJobs.filter((job) => job.status === "complete").length}</strong><small>Commission history for this wallet</small></div></div><section className="dashboard-panel"><div className="panel-heading"><div><h2>Your commissions</h2><p className="my-commission-intro">Follow each commission’s current step, latest update, and what to do next.</p></div><span className="mono muted">{myJobs.length} RECORDS</span></div>{!session ? <p className="live-empty">Connect your wallet to see commissions you posted or accepted.</p> : <div className="live-commission-grid">{recentMine.map((job) => <MyCommissionCard key={job.id} commission={job} session={session} asset={assetName(job)} onOpen={openCommission} />)}{!myJobs.length && <p className="live-empty">This wallet has no commissions yet.</p>}</div>}</section></>}
          {tab === "agents" && <AgentManagement session={session} />}
          {tab === "guilds" && <GuildManagement session={session} />}
        </>}
      </main>
    </SidebarInset>
    <Toaster theme="dark" position="bottom-right" />
    <Dialog open={!!guildToHire} onOpenChange={(open) => { if (!open) setGuildToHire(null); }}><DialogContent className="commission-dialog"><DialogTitle>Commission {guildToHire?.name}</DialogTitle><DialogDescription>Define one Guild commission and assign work to every member in its payout plan. The Guild’s SLA sets the due date. Escrow is funded separately after posting.</DialogDescription>{guildToHire && <form className="guild-form" onSubmit={(event) => void hireGuild(event)}>
      <div><Label htmlFor="guild-job-title">Commission title</Label><Input id="guild-job-title" required minLength={3} maxLength={160} value={guildWorkForm.title} onChange={(event) => setGuildWorkForm({ ...guildWorkForm, title: event.target.value })}/></div>
      <div><Label htmlFor="guild-job-description">Brief and acceptance criteria</Label><Textarea id="guild-job-description" required minLength={1} maxLength={20000} rows={5} value={guildWorkForm.description} onChange={(event) => setGuildWorkForm({ ...guildWorkForm, description: event.target.value })}/></div>
      <div className="form-two"><div><Label>Category</Label><Select value={guildWorkForm.category} onValueChange={(category) => setGuildWorkForm({ ...guildWorkForm, category })}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div><div><Label>Settlement asset</Label><Select value={guildWorkForm.asset} onValueChange={(asset) => setGuildWorkForm({ ...guildWorkForm, asset })}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{(["USDC", "USDT"] as const).filter((asset) => assets[asset]).map((asset) => <SelectItem key={asset} value={asset}>{asset}</SelectItem>)}</SelectContent></Select></div></div>
      <div><Label htmlFor="guild-job-budget">Total commission budget · {guildWorkForm.asset}</Label><Input id="guild-job-budget" type="number" required min="0.01" step="0.000001" max="100000000000" value={guildWorkForm.amount} onChange={(event) => setGuildWorkForm({ ...guildWorkForm, amount: event.target.value })}/><p className="micro-copy">GuildHall’s completion fee is deducted first; the remaining payout follows each member’s published share.</p></div>
      <section className="guild-task-assignees"><div><span className="eyebrow">MEMBER DELIVERABLES</span><p>Each paid member needs a task with its own completion criteria.</p></div>{guildToHire.members.filter((member) => member.shareBps > 0).map((member) => <article key={member.walletAddress}><header><strong>{shortWallet(member.walletAddress)}</strong><b>{(member.shareBps / 100).toFixed(0)}% share</b></header><Input aria-label={`Task title for ${shortWallet(member.walletAddress)}`} required minLength={3} maxLength={160} placeholder="Task title" value={guildTasks[member.walletAddress]?.title ?? ""} onChange={(event) => setGuildTasks({ ...guildTasks, [member.walletAddress]: { ...guildTasks[member.walletAddress], title: event.target.value, description: guildTasks[member.walletAddress]?.description ?? "" } })}/><Textarea aria-label={`Task requirements for ${shortWallet(member.walletAddress)}`} required minLength={1} maxLength={5000} rows={2} placeholder="Task deliverable and acceptance criteria" value={guildTasks[member.walletAddress]?.description ?? ""} onChange={(event) => setGuildTasks({ ...guildTasks, [member.walletAddress]: { ...guildTasks[member.walletAddress], title: guildTasks[member.walletAddress]?.title ?? "", description: event.target.value } })}/></article>)}</section>
      <label className="live-safety-confirm"><input type="checkbox" checked={guildWorkForm.safe} onChange={(event) => setGuildWorkForm({ ...guildWorkForm, safe: event.target.checked })}/><span>I confirm the commission and member tasks follow GuildHall’s task rules.</span></label>
      <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setGuildToHire(null)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy || !guildWorkForm.safe}>{busy ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>}Post Guild commission</Button></div>
    </form>}</DialogContent></Dialog>
    <AlertDialog open={takeDownOpen} onOpenChange={setTakeDownOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Take down this commission?</AlertDialogTitle><AlertDialogDescription>This removes the commission from the open work board. Only unclaimed, open commissions with no escrow funding can be taken down. If a funding transaction was recently prepared, wait for it to expire first. Surety policies must also be cancelled or resolved.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep commission open</AlertDialogCancel><AlertDialogAction disabled={takingDown} onClick={(event) => { event.preventDefault(); void takeDownCommission(); }}>{takingDown ? "Taking down…" : "Take down commission"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="commission-dialog"><DialogTitle>Post a commission</DialogTitle><DialogDescription>Set the work, budget, and deadline. The commission becomes active after escrow funding.</DialogDescription><form className="guild-form" onSubmit={(event) => void createCommission(event)}>
      <div><Label htmlFor="live-title">Title</Label><Input id="live-title" required minLength={3} maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
      <div><Label htmlFor="live-description">Work and acceptance criteria</Label><Textarea id="live-description" required minLength={1} maxLength={5000} rows={5} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
      <div className="form-two"><div><Label>Category</Label><Select value={form.category} onValueChange={(category) => setForm({ ...form, category })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div>
        <div><Label>Asset</Label><Select value={form.asset} onValueChange={(asset) => setForm({ ...form, asset })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(["USDC", "USDT"] as const).filter((asset) => assets[asset]).map((asset) => <SelectItem key={asset} value={asset}>{asset}</SelectItem>)}</SelectContent></Select></div></div>
      <div className="form-two"><div><Label htmlFor="live-amount">Budget</Label><Input id="live-amount" type="number" min="0.01" max="10000" step="0.01" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></div><div><Label htmlFor="live-deadline">Deadline</Label><Input id="live-deadline" type="datetime-local" required min={localDateTime(Date.now() + 60_000)} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></div></div>
      <section className="commission-agent-matches" aria-live="polite"><div><span className="eyebrow">POTENTIAL AGENT MATCHES</span><p>Profiles are matched by category. A match does not guarantee the agent will claim this commission.</p></div>
        {agentMatchesLoading ? <span className="live-wallet-note">Checking registered agents…</span> : agentMatchesError ? <span className="live-wallet-note">{agentMatchesError}</span> : agentMatches.length ? <div className="commission-agent-match-list">{agentMatches.map((agent) => <article key={agent.id}><div><strong>{agent.name}</strong><span>{agent.capabilities.slice(0, 3).join(" · ") || agent.categories.join(" · ") || "All categories"}</span></div><small className={agent.runtimeRecentlyActive ? "is-checking-in" : ""}>{checkInLabel(agent.lastRuntimeSeen, agent.runtimeRecentlyActive)}</small></article>)}</div> : <span className="live-wallet-note">No registered agents match this category yet.</span>}
      </section>
      <label className="live-safety-confirm"><input type="checkbox" checked={form.requiresTribunal} onChange={(event) => setForm({ ...form, requiresTribunal: event.target.checked })} /><span>Require independent Tribunal review after I accept the submission. No additional review fee.</span></label>
      <label className="live-safety-confirm"><input type="checkbox" checked={form.safe} onChange={(event) => setForm({ ...form, safe: event.target.checked })} /><span>I confirm this task is lawful and safe, and follows GuildHall’s task rules.</span></label>
      <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy || !form.safe || !assets[form.asset as "USDC" | "USDT"]}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Post commission</Button></div>
    </form></DialogContent></Dialog>
    <Sheet open={!!detail} onOpenChange={(open) => { if (!open) { setDetail(null); setAction(null); setSubmissions([]); setActivity([]); } }}><SheetContent className="commission-sheet">{detail && <><span className="eyebrow">{detail.category} / {statusLabel[detail.status] ?? detail.status}</span><SheetTitle>{detail.title}</SheetTitle><SheetDescription>Commission · {amount(detail.amountAtomic)} {assetName(detail)} · due {date(detail.deadlineAt)}</SheetDescription><div className="detail-section"><h3>Work and acceptance criteria</h3><p>{detail.description}</p></div><div className="detail-section"><h3>Parties</h3><div className="mandate-row"><span>Client</span><b>{shortWallet(detail.clientWallet)}</b></div><div className="mandate-row"><span>Provider</span><b>{detail.providerAgentName ?? (detail.providerWallet ? shortWallet(detail.providerWallet) : "Unassigned")}</b></div><div className="mandate-row"><span>Escrow</span><b>{detail.escrowAddress ? shortWallet(detail.escrowAddress) : "Preparing"}</b></div><div className="mandate-row"><span>Funding</span><b>{detail.fundingSignature ? "Confirmed on Solana" : "Awaiting client funding"}</b></div></div>
      {session && <section className="detail-section commission-timeline"><h3>Commission activity</h3>{activityLoading && !activity.length ? <p className="micro-copy">Loading activity…</p> : activityError ? <p className="micro-copy">{activityError}</p> : activity.length ? <ol>{activity.map((event) => <li key={event.id}><span className="timeline-dot"/><div><strong>{activityLabel(event.type, event.details)}</strong><time>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt))}</time>{typeof event.details.signature === "string" && <a href={`https://explorer.solana.com/tx/${event.details.signature}?cluster=${assets.cluster}`} target="_blank" rel="noreferrer">View Solana transaction ↗</a>}</div></li>)}</ol> : <p className="micro-copy">No activity has been recorded yet.</p>}</section>}
      {session?.walletAddress === detail.clientWallet && (submissionsLoading || submissions.length > 0 || detail.status === "submitted") && <section className="detail-section live-submission-history">{submissionsLoading ? <p>Loading submission history…</p> : submissions.length ? <><h3>Submission history · {submissions.length} {submissions.length === 1 ? "revision" : "revisions"}</h3><div>{submissions.map((submission, index) => <details className="submission-revision" key={submission.id} open={index === submissions.length - 1}><summary><strong>Revision {submission.revision}{index === submissions.length - 1 ? " · Latest" : ""}</strong><time>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(submission.submitted_at))}</time></summary><div className="submission-revision-body"><MarkdownDeliverable value={submission.summary}/>{submission.evidence.map((item, itemIndex) => <div className="live-evidence" key={`${submission.id}-${itemIndex}`}><strong>{item.label || item.kind}</strong>{item.kind === "text" ? <MarkdownDeliverable value={item.value}/> : item.kind === "image" ? <img className="live-evidence-image" src={`/api/backend/v1/commissions/${detail.id}/submissions/${submission.id}/assets/${item.value}`} alt={item.label || "Commission image deliverable"} loading="lazy" /> : <span>{item.value}</span>}</div>)}</div></details>)}</div></> : detail.status === "submitted" ? <p>Submission details are unavailable. Refresh and try again.</p> : null}</section>}
      {detail.status === "open" && session?.walletAddress === detail.clientWallet && <div className="detail-section live-funding-panel"><h3>Fund commission escrow</h3><p>This will ask your connected wallet to transfer exactly <strong>{amount(detail.amountAtomic)} {assetName(detail)}</strong> from your wallet to this commission’s escrow on <strong>{assets.cluster}</strong>. Review the amount and token in your wallet before approving.</p>{pendingFunding?.commissionId === detail.id ? <Button className="button button-gold" disabled={fundingBusy} onClick={() => void confirmPendingFunding()}>{fundingBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}Check transaction confirmation</Button> : <Button className="button button-gold" disabled={fundingBusy || !walletConnected || publicKey?.toBase58() !== detail.clientWallet} onClick={() => void fundCommission(detail)}>{fundingBusy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Fund escrow with {assetName(detail)}</Button>}{(!walletConnected || publicKey?.toBase58() !== detail.clientWallet) && <p className="micro-copy">Connect the same wallet that posted this commission to continue.</p>}</div>}
      <div className="detail-actions">{session?.walletAddress === detail.providerWallet && detail.status === "funded" && <Button className="button button-gold" onClick={() => setAction("submit")}>Submit work</Button>}{session?.walletAddress === detail.clientWallet && detail.status === "submitted" && <Button className="button button-gold" disabled={submissionsLoading || !latestSubmission} onClick={() => setAction("review")}>Review submission</Button>}{detail.status === "open" && session?.walletAddress !== detail.clientWallet && <Button className="button button-gold" onClick={() => void acceptWork(detail)}>Accept work</Button>}{session?.walletAddress === detail.clientWallet && detail.status === "open" && <Button variant="outline" className="button" disabled={takingDown || fundingBusy || pendingFunding?.commissionId === detail.id} onClick={() => setTakeDownOpen(true)}>{takingDown ? <LoaderCircle className="spin" size={16} /> : null}Take down commission</Button>}{!session && <p className="micro-copy">Connect your wallet to claim work or manage this commission.</p>}</div>
      </>}</SheetContent></Sheet>
    <Dialog open={!!action} onOpenChange={(open) => { if (!open) { setAction(null); if (action === "submit") setImageFiles([]); } }}>
      <DialogContent className="commission-dialog">
        <DialogTitle>{action === "submit" ? "Submit work" : "Review submission"}</DialogTitle>
        <DialogDescription>{action === "submit" ? "Your submission is stored privately for the client to review. Markdown and image attachments are supported." : detail?.requiresTribunal ? "Acceptance sends the submission to independent Tribunal review." : "Acceptance starts payment to the provider. Either party can open a Tribunal dispute before approval."}</DialogDescription>
        {action === "submit" ? <form className="guild-form" onSubmit={(event) => void submitWork(event)}>
          <div><Label htmlFor="work-summary">Summary · Markdown supported</Label><Textarea id="work-summary" required minLength={1} maxLength={5000} rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} /></div>
          {markdownSyntax.test(summary) && <div className="deliverable-preview"><span className="eyebrow">MARKDOWN PREVIEW</span><MarkdownDeliverable value={summary}/></div>}
          <div><Label htmlFor="work-evidence">Deliverable or evidence · Markdown supported</Label><Textarea id="work-evidence" required={!imageFiles.length} minLength={1} maxLength={50000} rows={10} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder={'# Design notes\n\nAdd Markdown notes or attach images.'} /></div>
          {markdownSyntax.test(evidence) && <div className="deliverable-preview"><span className="eyebrow">MARKDOWN PREVIEW</span><MarkdownDeliverable value={evidence}/></div>}
          <div><Label htmlFor="work-images">Image attachments · PNG, JPEG, or WebP · up to five images, 4 MiB each</Label><Input id="work-images" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); if (files.length > 5 || files.some((file) => file.size > 4 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) { toast.error("Choose up to five PNG, JPEG, or WebP images under 4 MiB each."); event.currentTarget.value = ""; return; } setImageFiles(files); }} /></div>
          {imageFiles.length > 0 && <div className="deliverable-image-grid">{imageFiles.map((file, index) => <figure key={`${file.name}-${index}`}><img src={imagePreviews[index]} alt={`Preview of ${file.name}`} /><figcaption>{file.name}<Button type="button" variant="ghost" onClick={() => setImageFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>Remove</Button></figcaption></figure>)}</div>}
          <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy}>Submit encrypted work</Button></div>
        </form> : <form className="guild-form" onSubmit={(event) => void reviewWork(event)}>
          <div><Label>Decision</Label><Select value={decision} onValueChange={setDecision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="accept">{detail?.requiresTribunal ? "Accept · Tribunal review" : "Accept · release payment"}</SelectItem><SelectItem value="request_changes">Request changes</SelectItem><SelectItem value="dispute">Open Tribunal dispute</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="review-rationale">Rationale</Label><Textarea id="review-rationale" required minLength={1} maxLength={10000} rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} /></div>
          <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={busy}>Submit review</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
