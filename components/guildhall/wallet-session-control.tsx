"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { Button } from "@/components/ui/button";
import { getWalletSession, guildhallApi, type WalletSession } from "@/lib/guildhall-api";

function announceSession(session: WalletSession | null) {
  window.dispatchEvent(new CustomEvent("guildhall-session-change", { detail: session }));
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unexpected wallet error. Check that your wallet is unlocked and try again.";
}

export function WalletSessionControl({ compact = false }: { compact?: boolean }) {
  const { connected, publicKey, signMessage, disconnect, wallet } = useWallet();
  const [session, setSession] = useState<WalletSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const attemptedWallet = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getWalletSession();
      setSession(next);
    } catch (error) {
      setMessage(errorMessage(error));
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
    const adapterError = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
    };
    window.addEventListener("guildhall-session-change", update);
    window.addEventListener("guildhall-wallet-adapter-error", adapterError);
    return () => {
      window.removeEventListener("guildhall-session-change", update);
      window.removeEventListener("guildhall-wallet-adapter-error", adapterError);
    };
  }, [refresh]);

  const authenticate = useCallback(async (walletAddress: string) => {
    if (!signMessage) {
      setMessage(`${wallet?.adapter.name ?? "This wallet"} does not support message signing.`);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const challenge = await guildhallApi<{ walletAddress: string; nonce: string; message: string }>("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ walletAddress }),
      });
      if (challenge.walletAddress !== walletAddress) {
        throw new Error("The sign-in challenge belongs to a different wallet.");
      }
      const signature = await signMessage(new TextEncoder().encode(challenge.message));
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress, nonce: challenge.nonce, signature: bs58.encode(signature) }),
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await response.json() as { data?: WalletSession; error?: { message?: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? `Wallet sign-in failed (${response.status}).`);
      }
      setSession(payload.data);
      announceSession(payload.data);
    } catch (error) {
      console.error("[GuildHall] Wallet sign-in failed:", error);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [signMessage, wallet]);

  useEffect(() => {
    if (!connected || !publicKey || loading) {
      if (!connected) attemptedWallet.current = null;
      return;
    }
    const address = publicKey.toBase58();
    if (session?.walletAddress === address || attemptedWallet.current === address) return;
    attemptedWallet.current = address;
    void authenticate(address);
  }, [authenticate, connected, loading, publicKey, session?.walletAddress]);

  const signOut = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Could not end this session (${response.status}).`);
      setSession(null);
      announceSession(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      try { await disconnect(); }
      catch (error) { console.error("[GuildHall] Wallet disconnect failed:", error); }
      setBusy(false);
    }
  };

  const retrySignIn = () => {
    if (!publicKey) return;
    attemptedWallet.current = publicKey.toBase58();
    void authenticate(publicKey.toBase58());
  };

  return (
    <div className={`wallet-session-control${compact ? " compact" : ""}`}>
      <WalletMultiButton className="button wallet-session-button" />
      {busy && <span className="wallet-session-message" role="status">Signing in to GuildHall…</span>}
      {session && (
        <div className="wallet-session-active">
          <span>GuildHall session · {session.walletAddress.slice(0, 4)}…{session.walletAddress.slice(-4)}</span>
          <Button type="button" variant="ghost" className="wallet-session-signout" disabled={busy || loading} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      )}
      {connected && !session && !busy && !loading && (
        <Button type="button" variant="ghost" className="wallet-session-signout" onClick={retrySignIn}>
          Sign in to GuildHall
        </Button>
      )}
      {message && <span className="wallet-session-message" role="alert">{message}</span>}
    </div>
  );
}
