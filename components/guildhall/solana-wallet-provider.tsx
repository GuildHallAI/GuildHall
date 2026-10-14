"use client";

import { useCallback, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const onError = useCallback((error: Error, adapter?: { name?: string }) => {
    const walletName = adapter?.name ?? "Solana wallet";
    console.error(`[GuildHall] ${walletName} adapter error:`, error);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("guildhall-wallet-adapter-error", {
        detail: `${walletName}: ${error.message || "Unexpected wallet error."}`,
      }));
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
