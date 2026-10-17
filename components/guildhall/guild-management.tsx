"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { toast } from "sonner";
import { Layers3, LoaderCircle, Plus, RefreshCw, ShieldCheck } from "./gothic-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { guildhallApi, type WalletSession } from "@/lib/guildhall-api";

type GuildMember = { user_id: string; wallet_address: string; role: "lead" | "member"; share_bps: number; joined_at: string };
type Guild = {
  id: string; owner_user_id: string; name: string; description: string; sla_hours: number;
  bond_target_atomic: string; bond_wallet_public_key: string; bond_mint: string; status: string;
  bond_confirmed_atomic: string; bond_funded: boolean; members: GuildMember[];
};
type Invitation = { id: string; guild_id: string; guild_name: string; sla_hours: number; created_at: string };
type BondInstructions = { guildId: string; depositId: string; amountAtomic: string; assetMint: string; unsignedTransaction: string; lastValidBlockHeight: number };
const displayAmount = (atomic: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(BigInt(atomic)) / 1_000_000);
const walletShort = (wallet: string) => `${wallet.slice(0, 5)}…${wallet.slice(-4)}`;

export function GuildManagement({ session }: { session: WalletSession | null }) {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "", slaHours: "72", bondTarget: "10" });
  const [inviteWallet, setInviteWallet] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, Record<string, string>>>({});

  const refresh = useCallback(async () => {
    if (!session) { setGuilds([]); setInvitations([]); return; }
    setLoading(true); setError("");
    try {
      const [mine, incoming] = await Promise.all([
        guildhallApi<Guild[]>("/guilds/mine"),
        guildhallApi<Invitation[]>("/guilds/invitations"),
      ]);
      setGuilds(mine);
      setInvitations(incoming);
      setShares((current) => Object.fromEntries(mine.map((guild) => [guild.id, Object.fromEntries(guild.members.map((member) => [member.wallet_address, current[guild.id]?.[member.wallet_address] ?? String(member.share_bps / 100)]))])));
    } catch (cause) { setError((cause as Error).message || "Could not load Guilds."); }
    finally { setLoading(false); }
  }, [session]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const createGuild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!session) return;
    setBusy("create");
    try {
      await guildhallApi<Guild>("/guilds", { method: "POST", body: JSON.stringify({ ...createForm, slaHours: Number(createForm.slaHours) }) });
      setCreateOpen(false); setCreateForm({ name: "", description: "", slaHours: "72", bondTarget: "10" });
      toast.success("Guild created. Invite members and configure its payout shares."); await refresh();
    } catch (cause) { toast.error((cause as Error).message || "Could not create this Guild."); }
    finally { setBusy(""); }
  };

  const invite = async (guild: Guild) => {
    const walletAddress = inviteWallet[guild.id]?.trim(); if (!walletAddress) return;
    setBusy(`invite:${guild.id}`);
    try {
      await guildhallApi(`/guilds/${guild.id}/invitations`, { method: "POST", body: JSON.stringify({ walletAddress }) });
      setInviteWallet((current) => ({ ...current, [guild.id]: "" }));
      toast.success("Guild invitation sent.");
    } catch (cause) { toast.error((cause as Error).message || "Could not invite that wallet."); }
    finally { setBusy(""); }
  };

  const accept = async (invitation: Invitation) => {
    setBusy(`accept:${invitation.id}`);
    try {
      await guildhallApi(`/guilds/${invitation.guild_id}/invitations/${invitation.id}/accept`, { method: "POST", body: JSON.stringify({}) });
      toast.success(`Joined ${invitation.guild_name}.`); await refresh();
    } catch (cause) { toast.error((cause as Error).message || "Could not accept this invitation."); }
    finally { setBusy(""); }
  };

  const saveShares = async (guild: Guild) => {
    const entries = guild.members.map((member) => ({ walletAddress: member.wallet_address, shareBps: Math.round(Number(shares[guild.id]?.[member.wallet_address] ?? 0) * 100) }));
    if (entries.some((entry) => !Number.isFinite(entry.shareBps) || entry.shareBps <= 0) || entries.reduce((sum, entry) => sum + entry.shareBps, 0) !== 10000) {
      toast.error("Give every member a share above 0%. Shares must total exactly 100%."); return;
    }
    setBusy(`shares:${guild.id}`);
    try {
      await guildhallApi(`/guilds/${guild.id}/shares`, { method: "PUT", body: JSON.stringify({ shares: entries }) });
      toast.success("Guild payout shares saved."); await refresh();
    } catch (cause) { toast.error((cause as Error).message || "Could not save payout shares."); }
    finally { setBusy(""); }
  };

  const fundBond = async (guild: Guild) => {
    if (!session || !publicKey || !connected || publicKey.toBase58() !== session.walletAddress || !signTransaction) {
      toast.error("Connect and sign in with the wallet that will fund this Guild bond."); return;
    }
    setBusy(`bond:${guild.id}`);
    try {
      const instructions = await guildhallApi<BondInstructions>(`/guilds/${guild.id}/bond-instructions`, { method: "POST", body: JSON.stringify({}) });
      if (instructions.guildId !== guild.id || instructions.assetMint !== guild.bond_mint) throw new Error("Bond instructions do not match this Guild. Refresh and try again.");
      const raw = atob(instructions.unsignedTransaction);
      const transaction = Transaction.from(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
      const signed = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
      if (!transaction.recentBlockhash) throw new Error("The bond transaction has no recent blockhash. Refresh and try again.");
      const confirmation = await connection.confirmTransaction({ signature, blockhash: transaction.recentBlockhash, lastValidBlockHeight: instructions.lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) throw new Error("Solana rejected the Guild bond transfer. Check your wallet and try again.");
      await guildhallApi(`/guilds/${guild.id}/bond-confirm`, { method: "POST", body: JSON.stringify({ depositId: instructions.depositId, signature }) });
      toast.success("Guild USDC bond confirmed."); await refresh();
    } catch (cause) { toast.error((cause as Error).message || "Could not fund this Guild bond."); }
    finally { setBusy(""); }
  };

  return <div className="guild-management">
    <section className="dashboard-panel">
      <div className="panel-heading"><div><h2>Build a Guild</h2><p className="my-commission-intro">Bring wallet holders together, define the split, then fund the shared USDC bond to qualify for the Guild Board.</p></div><Button className="button button-gold" disabled={!session} onClick={() => setCreateOpen((value) => !value)}><Plus size={16} />Create Guild</Button></div>
      {!session ? <p className="live-empty">Connect the wallet that will lead this Guild.</p> : createOpen && <form className="guild-create-form" onSubmit={(event) => void createGuild(event)}>
        <label><Label htmlFor="guild-name">Guild name</Label><Input id="guild-name" required minLength={2} maxLength={100} value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} placeholder="e.g. GuildHall Studio" /></label>
        <label><Label htmlFor="guild-description">What the Guild does</Label><Textarea id="guild-description" required maxLength={3000} value={createForm.description} onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} placeholder="Describe the team's services and strengths." /></label>
        <div className="guild-create-options"><label><Label htmlFor="guild-sla">Service SLA in hours</Label><Input id="guild-sla" type="number" min="1" max="8760" required value={createForm.slaHours} onChange={(event) => setCreateForm({ ...createForm, slaHours: event.target.value })} /></label><label><Label htmlFor="guild-bond">Shared USDC bond target</Label><Input id="guild-bond" type="number" min="0.000001" step="0.000001" required value={createForm.bondTarget} onChange={(event) => setCreateForm({ ...createForm, bondTarget: event.target.value })} /></label></div>
        <p className="micro-copy">The bond is real USDC on {"Solana"}. Members can contribute toward the target. It remains subject to Guild rules and return conditions.</p>
        <div className="guild-form-actions"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button className="button button-gold" disabled={busy === "create"}>{busy === "create" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Create Guild</Button></div>
      </form>}
    </section>

    {!!invitations.length && <section className="dashboard-panel"><div className="panel-heading"><div><h2>Guild invitations</h2><p className="my-commission-intro">Accept an invitation to join its roster and receive assigned Guild work.</p></div></div><div className="guild-invitation-list">{invitations.map((invitation) => <article key={invitation.id}><div><strong>{invitation.guild_name}</strong><span>{invitation.sla_hours}h service SLA</span></div><Button className="button button-gold" disabled={busy === `accept:${invitation.id}`} onClick={() => void accept(invitation)}>{busy === `accept:${invitation.id}` ? <LoaderCircle className="spin" size={16} /> : "Accept invitation"}</Button></article>)}</div></section>}

    <section className="dashboard-panel"><div className="panel-heading"><div><h2>Your Guilds</h2><p className="my-commission-intro">Manage the roster, payout plan, and shared bond for Guilds you lead or belong to.</p></div><Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</Button></div>
      {error ? <div className="live-empty"><p>{error}</p><Button variant="outline" onClick={() => void refresh()}>Try again</Button></div> : loading ? <p className="live-empty"><LoaderCircle className="spin" size={16} /> Loading Guilds…</p> : !guilds.length ? <div className="empty-state"><Layers3 size={28} /><h2>No Guilds yet</h2><p>Create one to invite collaborators, set member shares, and fund its bond.</p></div> : <div className="guild-management-list">{guilds.map((guild) => {
        const isLead = guild.owner_user_id === session?.userId;
        const shareTotal = guild.members.reduce((sum, member) => sum + member.share_bps, 0);
        const funded = BigInt(guild.bond_confirmed_atomic) >= BigInt(guild.bond_target_atomic);
        return <article className="guild-management-card" key={guild.id}>
          <header><div><span className="eyebrow">{isLead ? "GUILD LEAD" : "GUILD MEMBER"} · {guild.status.toUpperCase()}</span><h3>{guild.name}</h3></div><span className={`status ${funded ? "status-complete" : "status-open"}`}>{funded ? "BOND FUNDED" : "BOND INCOMPLETE"}</span></header>
          <p>{guild.description}</p>
          <div className="guild-management-facts"><div><span>Bond progress</span><strong>{displayAmount(guild.bond_confirmed_atomic)} / {displayAmount(guild.bond_target_atomic)} USDC</strong></div><div><span>Service SLA</span><strong>{guild.sla_hours} hours</strong></div><div><span>Roster</span><strong>{guild.members.length} members</strong></div></div>
          <div className="guild-roster-heading"><span className="eyebrow">MEMBERS AND PAYOUT SHARES</span><span className="mono muted">{(shareTotal / 100).toFixed(0)}% / 100%</span></div>
          <div className="guild-roster">{guild.members.map((member) => <div className="guild-roster-row" key={member.user_id}><span><strong>{member.role === "lead" ? "Lead" : "Member"}</strong><small>{walletShort(member.wallet_address)}{member.wallet_address === session?.walletAddress ? " · You" : ""}</small></span>{isLead ? <label><Input aria-label={`Payout share for ${member.wallet_address}`} type="number" min="0.01" max="100" step="0.01" value={shares[guild.id]?.[member.wallet_address] ?? "0"} onChange={(event) => setShares((current) => ({ ...current, [guild.id]: { ...current[guild.id], [member.wallet_address]: event.target.value } }))} /><span>%</span></label> : <b>{(member.share_bps / 100).toFixed(2)}%</b>}</div>)}</div>
          {isLead && <div className="guild-setup-actions"><form onSubmit={(event) => { event.preventDefault(); void invite(guild); }}><Label htmlFor={`invite-${guild.id}`}>Invite by GuildHall wallet</Label><div><Input id={`invite-${guild.id}`} required minLength={32} maxLength={44} value={inviteWallet[guild.id] ?? ""} onChange={(event) => setInviteWallet((current) => ({ ...current, [guild.id]: event.target.value }))} placeholder="Member wallet address" /><Button variant="outline" disabled={busy === `invite:${guild.id}`}>{busy === `invite:${guild.id}` ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Invite</Button></div><small>Invitees must sign in to GuildHall with this wallet before you can invite them.</small></form><Button variant="outline" disabled={busy === `shares:${guild.id}` || !guild.members.length} onClick={() => void saveShares(guild)}>{busy === `shares:${guild.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Save payout shares</Button></div>}
          <footer><span className="micro-copy">Bond vault · {walletShort(guild.bond_wallet_public_key)}</span>{!funded && <Button className="button button-gold" disabled={busy === `bond:${guild.id}`} onClick={() => void fundBond(guild)}>{busy === `bond:${guild.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Contribute USDC bond</Button>}</footer>
        </article>;
      })}</div>}
    </section>
  </div>;
}
