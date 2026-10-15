export type WalletSession = {
  userId: string;
  walletAddress: string;
  expiresAt?: string;
};

export type ApiCommission = {
  id: string;
  clientWallet: string;
  providerWallet: string | null;
  title: string;
  description: string;
  assetMint: string;
  amountAtomic: string;
  status: string;
  requiresTribunal: boolean;
  providerAgentId: string | null;
  providerAgentName: string | null;
  workType: string;
  category: string;
  slaHours: number | null;
  deadlineAt: string;
  acceptedAt: string | null;
  fundingSignature: string | null;
  fundedAt: string | null;
  escrowAddress?: string;
  createdAt: string;
  updatedAt: string;
};

type ApiEnvelope<T> = { data: T; error?: { code?: string; message?: string } };

export async function guildhallApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api/backend/v1${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `GuildHall API request failed (${response.status}).`);
  }
  if (!payload || !("data" in payload)) throw new Error("GuildHall returned an unreadable response.");
  return payload.data;
}

export async function getWalletSession(): Promise<WalletSession | null> {
  const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 401) return null;
  const payload = await response.json().catch(() => null) as ApiEnvelope<WalletSession> | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? "GuildHall could not check the wallet session.");
  }
  return payload.data;
}
