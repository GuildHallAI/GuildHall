"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getWalletSession, type WalletSession } from "@/lib/guildhall-api";
import { encodeBase58 } from "@/lib/solana-base58";

type SolanaProvider = {
  publicKey?: { toBase58?: () => string; toString: () => string } | null;
  connect: () => Promise<{ publicKey?: { toBase58?: () => string; toString: () => string } }>;
  signMessage: (message: Uint8Array, display?: "utf8") => Promise<Uint8Array | { signature: Uint8Array }>;
};

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
  }
}

function walletAddressOf(key: SolanaProvider["publicKey"]) {
  return key?.toBase58?.() ?? key?.toString() ?? "";
}

function announceSession(session: WalletSession | null) {
  window.dispatchEvent(new CustomEvent("guildhall-session-change", { detail: session }));
}

export function WalletSessionControl({ compact = false }: { compact?: boolean }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await getWalletSession();
      setSession(next);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const update = (event: Event) => {
      const next = (event as CustomEvent<WalletSession | null>).detail;
      setSession(next);
      setMessage("");
    };
    window.addEventListener("guildhall-session-change", update);
    return () => window.removeEventListener("guildhall-session-change", update);
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    setMessage("");
    try {
      const wallet = window.phantom?.solana ?? window.solflare ?? window.solana;
      if (!wallet?.connect || !wallet.signMessage) {
        throw new Error("Install Phantom or Solflare to sign in with a Solana wallet.");
      }
      const connected = await wallet.connect();
      const walletAddress = walletAddressOf(connected.publicKey ?? wallet.publicKey);
      if (!walletAddress) throw new Error("The wallet did not provide a public address.");
      const challenge = await fetch("/api/backend/v1/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress }),
        cache: "no-store",
      });
      const noncePayload = await challenge.json() as { data?: { walletAddress: string; nonce: string; message: string }; error?: { message?: string } };
      if (!challenge.ok || !noncePayload.data) throw new Error(noncePayload.error?.message ?? "Could not request a wallet sign-in challenge.");
      if (noncePayload.data.walletAddress !== walletAddress) throw new Error("The sign-in challenge belongs to a different wallet.");
      const signed = await wallet.signMessage(new TextEncoder().encode(noncePayload.data.message), "utf8");
      const signature = signed instanceof Uint8Array ? signed : signed.signature;
      const verified = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress, nonce: noncePayload.data.nonce, signature: encodeBase58(signature) }),
        cache: "no-store",
        credentials: "same-origin",
      });
      const sessionPayload = await verified.json() as { data?: WalletSession; error?: { message?: string } };
      if (!verified.ok || !sessionPayload.data) throw new Error(sessionPayload.error?.message ?? "The wallet signature could not be verified.");
      setSession(sessionPayload.data);
      announceSession(sessionPayload.data);
    } catch (error) {
      setMessage((error as Error).message || "Wallet sign-in was cancelled.");
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
      setSession(null);
      announceSession(null);
    } catch {
      setMessage("Could not end this session. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const label = loading ? "Checking wallet…" : busy ? "Connecting…"
    : session ? `${session.walletAddress.slice(0, 4)}…${session.walletAddress.slice(-4)} · Sign out`
      : "Connect wallet";
  return <div className={`wallet-session-control${compact ? " compact" : ""}`}>
    <Button type="button" variant={session ? "outline" : "default"} className="button wallet-session-button" disabled={loading || busy} onClick={() => void (session ? signOut() : connect())}>
      {label}
    </Button>
    {message && <span className="wallet-session-message" role="status">{message}</span>}
  </div>;
}
