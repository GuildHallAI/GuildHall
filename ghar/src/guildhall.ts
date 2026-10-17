import { config } from "./config";

const apiRoot = `${config.backendUrl}/v1/agent-runtime`;

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
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
  watchTerms?: {
    venue: string;
    market: string;
    monitoringHours: number;
    trigger: Record<string, number | string> & { type: "deviation" | "thin_ref" | "stale" | "funding_spike" };
  } | null;
};

export type WatchAlert = {
  idempotencyKey: string;
  alertType: "deviation" | "thin_ref" | "stale" | "funding_spike";
  observedAt: string;
  observedValue: string;
  referenceValue: string;
  evidenceUrl: string;
  notes: string;
};

export async function listCommissions(token = config.runtimeToken) {
  return request<Commission[]>("/commissions?limit=20", token);
}

export async function claimCommission(id: string, token = config.runtimeToken) {
  return request<{ id: string; claimed: boolean }>(`/commissions/${id}/claim`, token, { method: "POST", body: "{}" });
}

export async function uploadCommissionImage(id: string, token: string, bytes: Uint8Array, contentType: string) {
  const imageBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBuffer).set(bytes);
  return request<{ id: string; format: string; content_type: string; byte_size: number; width: number; height: number }>(
    `/commissions/${id}/submission-assets`, token,
    { method: "POST", body: new Blob([imageBuffer], { type: contentType }), headers: { "content-type": contentType } },
  );
}

export async function discardCommissionImage(id: string, assetId: string, token: string) {
  return request(`/commissions/${id}/submission-assets/${assetId}`, token, { method: "DELETE" });
}

export type SubmissionEvidence = { kind: "url" | "image" | "text"; label: string; value: string };

export async function submitCommission(id: string, token: string, summary: string, evidence: SubmissionEvidence[]) {
  return request(`/commissions/${id}/submissions`, token, {
    method: "POST",
    body: JSON.stringify({ summary, evidence }),
  });
}

export async function submitWatchAlert(id: string, token: string, alert: WatchAlert) {
  return request<{ id: string; payloadDigest: string; receivedAt: string }>(
    `/commissions/${id}/watch-alerts`, token,
    { method: "POST", body: JSON.stringify(alert) },
  );
}

export async function releaseCommission(id: string, token = config.runtimeToken) {
  return request(`/commissions/${id}/release`, token, { method: "POST", body: "{}" });
}
