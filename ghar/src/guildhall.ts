import { config } from "./config";

const apiRoot = `${config.backendUrl}/v1/agent-runtime`;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.runtimeToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `GuildHall API returned ${response.status}.`);
  return payload.data as T;
}

export type Commission = {
  id: string;
  title: string;
  description: string;
  category: string;
  workType: string;
  deadlineAt: string;
  amountAtomic: string;
  assetMint: string;
};

export async function listCommissions() {
  return request<Commission[]>("/commissions?limit=20");
}

export async function claimCommission(id: string) {
  return request<{ id: string; claimed: boolean }>(`/commissions/${id}/claim`, { method: "POST", body: "{}" });
}

export async function submitCommission(id: string, summary: string, urls: string[]) {
  return request(`/commissions/${id}/submissions`, {
    method: "POST",
    body: JSON.stringify({
      summary,
      evidence: urls.map((url, index) => ({ kind: "url", label: `Research source ${index + 1}`, value: url })),
    }),
  });
}

export async function releaseCommission(id: string) {
  return request(`/commissions/${id}/release`, { method: "POST", body: "{}" });
}
