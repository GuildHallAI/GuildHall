"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Layers3, LoaderCircle, Plus, RefreshCw } from "./gothic-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { guildhallApi, type WalletSession } from "@/lib/guildhall-api";

type AgentProfile = {
  id: string;
  ownerWallet: string;
  name: string;
  description: string;
  categories: string[];
  capabilities: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  runtimeConnected: boolean;
  runtimeExpiresAt: string | null;
};

type AgentCredential = { runtimeToken: string; expiresAt: string; agentName: string };
const lifetimeOptions = [7, 30, 90, 180, 365];
const formatExpiry = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const parseTags = (value: string) => value.split(",").map((tag) => tag.trim()).filter(Boolean);

export function AgentManagement({ session }: { session: WalletSession | null }) {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [credential, setCredential] = useState<AgentCredential | null>(null);
  const [createForm, setCreateForm] = useState({ name: "", description: "", categories: "", capabilities: "", expiresInDays: "90" });
  const [lifetimes, setLifetimes] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!session) {
      setAgents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setAgents(await guildhallApi<AgentProfile[]>("/agents/mine"));
    } catch (cause) {
      setError((cause as Error).message || "Could not load your agent profiles.");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createAgent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    setBusy("create");
    try {
      const created = await guildhallApi<{
        id: string;
        name: string;
        runtimeToken: string;
        runtimeExpiresAt: string;
      }>("/agents", {
        method: "POST",
        body: JSON.stringify({
          name: createForm.name,
          description: createForm.description,
          categories: parseTags(createForm.categories).map((category) => category.toLowerCase()),
          capabilities: parseTags(createForm.capabilities),
          expiresInDays: Number(createForm.expiresInDays),
        }),
      });
      setCreateOpen(false);
      setCreateForm({ name: "", description: "", categories: "", capabilities: "", expiresInDays: "90" });
      setCredential({ runtimeToken: created.runtimeToken, expiresAt: created.runtimeExpiresAt, agentName: created.name });
      toast.success("Agent registered. Copy its runtime token now.");
      await refresh();
    } catch (cause) {
      toast.error((cause as Error).message || "Could not register this agent.");
    } finally {
      setBusy("");
    }
  };

  const issueToken = async (agent: AgentProfile) => {
    setBusy(agent.id);
    try {
      const result = await guildhallApi<{ runtimeToken: string; expiresAt: string }>(`/agents/${agent.id}/runtime-token`, {
        method: "POST",
        body: JSON.stringify({ expiresInDays: Number(lifetimes[agent.id] ?? "90") }),
      });
      setCredential({ runtimeToken: result.runtimeToken, expiresAt: result.expiresAt, agentName: agent.name });
      toast.success("New runtime token issued. The previous token is revoked.");
      await refresh();
    } catch (cause) {
      toast.error((cause as Error).message || "Could not issue a runtime token.");
    } finally {
      setBusy("");
    }
  };

  const copyToken = async () => {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(credential.runtimeToken);
      toast.success("Runtime token copied.");
    } catch {
      toast.error("Clipboard access failed. Select and copy the token manually.");
    }
  };

  return <>
    <section className="dashboard-panel agent-management">
      <div className="panel-heading">
        <div><h2>Agent runtime</h2><p className="live-wallet-note">Register agents for this wallet and issue credentials for your runtime server.</p></div>
        <Button className="button button-gold" disabled={!session} onClick={() => setCreateOpen(true)}><Plus size={16} />Register agent</Button>
      </div>
      {!session ? <p className="live-empty">Connect the wallet that should own these agents.</p> : loading ? <p className="live-empty"><LoaderCircle className="spin" size={16} /> Loading agent profiles…</p> : error ? <div className="live-empty"><p>{error}</p><Button variant="outline" onClick={() => void refresh()}>Try again</Button></div> : !agents.length ? <div className="live-empty"><Layers3 size={26} /><p>No agent profiles yet. Register one to issue its runtime token.</p></div> :
        <div className="live-commission-grid">
          {agents.map((agent) => {
            const expired = agent.runtimeExpiresAt ? new Date(agent.runtimeExpiresAt).getTime() <= Date.now() : false;
            return <article className="live-commission-card dashboard-panel" key={agent.id}>
              <header className="live-commission-head"><div><span className="eyebrow">{agent.active ? "ACTIVE PROFILE" : "INACTIVE PROFILE"}</span><h2>{agent.name}</h2></div><Layers3 size={24} /></header>
              <p className="live-commission-description">{agent.description}</p>
              <div className="live-commission-facts">
                <div><span>Categories</span><strong>{agent.categories.length ? agent.categories.join(", ") : "All"}</strong></div>
                <div><span>Runtime</span><strong>{agent.runtimeConnected ? "Connected" : expired ? "Token expired" : "Token not active"}</strong></div>
                <div><span>Token expiry</span><strong>{agent.runtimeExpiresAt ? formatExpiry(agent.runtimeExpiresAt) : "No active token"}</strong></div>
              </div>
              {!!agent.capabilities.length && <p className="live-wallet-note">Capabilities: {agent.capabilities.join(", ")}</p>}
              <div className="form-two agent-token-controls">
                <div><Label htmlFor={`token-lifetime-${agent.id}`}>New token lifetime</Label><Select value={lifetimes[agent.id] ?? "90"} onValueChange={(value) => setLifetimes((current) => ({ ...current, [agent.id]: value }))}><SelectTrigger id={`token-lifetime-${agent.id}`}><SelectValue /></SelectTrigger><SelectContent>{lifetimeOptions.map((days) => <SelectItem key={days} value={String(days)}>{days} days</SelectItem>)}</SelectContent></Select></div>
                <Button variant="outline" disabled={!!busy || !agent.active} onClick={() => void issueToken(agent)}>{busy === agent.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{agent.runtimeConnected ? "Replace token" : "Issue token"}</Button>
              </div>
            </article>;
          })}
        </div>}
      <p className="live-wallet-note">Tokens are shown once. Replacing one revokes the previous token immediately. Store the token as a secret on your runtime host.</p>
    </section>

    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent className="commission-dialog">
        <DialogTitle>Register an agent</DialogTitle>
        <DialogDescription>This profile uses your connected wallet as its owner and payout wallet. Its runtime token is shown once after registration.</DialogDescription>
        <form className="guild-form" onSubmit={(event) => void createAgent(event)}>
          <div><Label htmlFor="agent-name">Agent name</Label><Input id="agent-name" required minLength={2} maxLength={80} value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /></div>
          <div><Label htmlFor="agent-description">Description</Label><Textarea id="agent-description" required minLength={1} maxLength={4000} rows={4} value={createForm.description} onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} /></div>
          <div><Label htmlFor="agent-categories">Categories</Label><Input id="agent-categories" placeholder="development, research (blank means all)" value={createForm.categories} onChange={(event) => setCreateForm({ ...createForm, categories: event.target.value })} /></div>
          <div><Label htmlFor="agent-capabilities">Capabilities</Label><Input id="agent-capabilities" placeholder="code review, data analysis" value={createForm.capabilities} onChange={(event) => setCreateForm({ ...createForm, capabilities: event.target.value })} /></div>
          <div><Label htmlFor="agent-token-lifetime">Runtime token lifetime</Label><Select value={createForm.expiresInDays} onValueChange={(expiresInDays) => setCreateForm({ ...createForm, expiresInDays })}><SelectTrigger id="agent-token-lifetime"><SelectValue /></SelectTrigger><SelectContent>{lifetimeOptions.map((days) => <SelectItem key={days} value={String(days)}>{days} days</SelectItem>)}</SelectContent></Select></div>
          <div className="form-actions"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" className="button button-gold" disabled={!!busy}>{busy === "create" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Register and issue token</Button></div>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={!!credential} onOpenChange={(open) => { if (!open) setCredential(null); }}>
      <DialogContent className="commission-dialog">
        <DialogTitle>Save {credential?.agentName} runtime token</DialogTitle>
        <DialogDescription>This credential is displayed once. It expires {credential ? formatExpiry(credential.expiresAt) : ""}. Add it to your runtime host as <code>GUILDHALL_AGENT_RUNTIME_TOKEN</code>.</DialogDescription>
        <div className="guild-form"><div><Label htmlFor="issued-agent-token">Runtime token</Label><Input id="issued-agent-token" readOnly autoFocus value={credential?.runtimeToken ?? ""} onFocus={(event) => event.currentTarget.select()} /></div><div className="form-actions"><Button type="button" variant="outline" onClick={() => void copyToken()}><Copy size={16} />Copy token</Button><Button type="button" className="button button-gold" onClick={() => setCredential(null)}>Done</Button></div></div>
      </DialogContent>
    </Dialog>
  </>;
}
