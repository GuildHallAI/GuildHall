import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieName = "guildhall_session";
const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api",
};

function backendEndpoint(path: string) {
  const base = process.env.GUILDHALL_BACKEND_URL;
  if (!base) throw new Error("GuildHall API is not configured.");
  const endpoint = new URL(base);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("The GuildHall API must use HTTPS.");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}${path}`;
  return endpoint;
}

async function forward(path: string, token: string, method: "GET" | "DELETE") {
  return fetch(backendEndpoint(path), {
    method,
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function GET() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  // This endpoint is queried on first render by each wallet control. An absent
  // session is ordinary state, not an application error or a failed resource.
  if (!token) return Response.json({ data: null }, { headers: { "cache-control": "no-store" } });
  try {
    const upstream = await forward("/v1/auth/me", token, "GET");
    if (upstream.status === 401) {
      await jar.delete(cookieName);
      return Response.json({ data: null }, { headers: { "cache-control": "no-store" } });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: { code: "backend_unavailable", message: "GuildHall could not verify the wallet session." } }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let input: { walletAddress?: unknown; nonce?: unknown; signature?: unknown };
  try { input = await request.json(); }
  catch { return Response.json({ error: { code: "invalid_request", message: "A JSON wallet signature is required." } }, { status: 400 }); }
  if (typeof input.walletAddress !== "string" || typeof input.nonce !== "string" || typeof input.signature !== "string") {
    return Response.json({ error: { code: "invalid_request", message: "Wallet address, nonce, and signature are required." } }, { status: 400 });
  }
  try {
    const upstream = await fetch(backendEndpoint("/v1/auth/verify"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await upstream.json() as { data?: { token?: string; expiresAt?: string; userId?: string; walletAddress?: string }; error?: unknown };
    if (!upstream.ok || !payload.data?.token || !payload.data.expiresAt) {
      return Response.json(payload, { status: upstream.status, headers: { "cache-control": "no-store" } });
    }
    const jar = await cookies();
    jar.set(cookieName, payload.data.token, {
      ...sessionCookieOptions,
      expires: new Date(payload.data.expiresAt),
    });
    return Response.json({ data: { userId: payload.data.userId, walletAddress: payload.data.walletAddress, expiresAt: payload.data.expiresAt } }, {
      status: upstream.status,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: { code: "backend_unavailable", message: "GuildHall could not establish the wallet session." } }, { status: 502 });
  }
}

export async function DELETE() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  try {
    if (token) await forward("/v1/auth/session", token, "DELETE");
  } catch {
    // Clear the browser session even if the API is temporarily unavailable.
  }
  await jar.delete(cookieName);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
