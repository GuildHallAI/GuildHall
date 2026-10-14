import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedRoots = new Set([
  "auth",
  "reports",
  "commissions",
  "registry",
  "evaluators",
  "tribunal",
  "agent-accounts",
  "hands",
  "rate-board",
  "bounties",
  "bounty-x",
  "interop",
  "crews",
  "guilds",
  "surety",
  "charters",
  "proving-ground",
  "ghall",
]);
const allowedMethods = new Set(["GET", "POST", "PUT", "DELETE"]);
const forwardedHeaders = ["authorization", "content-type", "idempotency-key"];

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    !path.length ||
    path[0] !== "v1" ||
    !allowedRoots.has(path[1] ?? "") ||
    path.length > 8 ||
    path.some((segment) => !/^[a-zA-Z0-9-]+$/.test(segment))
  ) {
    return Response.json({ error: { code: "not_found", message: "API route not found." } }, { status: 404 });
  }
  if (!allowedMethods.has(request.method)) {
    return Response.json({ error: { code: "method_not_allowed", message: "Method not allowed." } }, { status: 405 });
  }

  const backendUrl = process.env.GUILDHALL_BACKEND_URL;
  if (!backendUrl) {
    return Response.json({ error: { code: "backend_unavailable", message: "GuildHall API is not configured." } }, { status: 503 });
  }

  let destination: URL;
  try {
    destination = new URL(backendUrl);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname);
    if (destination.protocol !== "https:" && !isLoopback) throw new Error("HTTPS is required.");
    destination.pathname = `${destination.pathname.replace(/\/$/, "")}/${path.map(encodeURIComponent).join("/")}`;
    destination.search = request.nextUrl.search;
  } catch {
    return Response.json({ error: { code: "backend_misconfigured", message: "GuildHall API configuration is invalid." } }, { status: 503 });
  }

  const headers = new Headers();
  for (const name of forwardedHeaders.filter((name) => name !== "authorization")) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const sessionToken = (await cookies()).get("guildhall_session")?.value;
  const authorization = sessionToken ? `Bearer ${sessionToken}` : request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const body = request.method === "GET" ? undefined : await request.arrayBuffer();

  try {
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: { code: "backend_unavailable", message: "GuildHall API could not be reached." } }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
