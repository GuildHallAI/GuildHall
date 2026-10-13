import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { domainToASCII } from "node:url";
import type { NextFunction, Request, Response } from "express";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { submitAgentTransfer } from "../agent-accounts.js";
import { decryptSolanaSecretKey } from "../escrow-wallets.js";
import { decryptPrivateData, encryptPrivateData } from "../private-data.js";

export const agentAccountsRouter = Router();
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const requiredTransferPrograms = [TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()];
const x402Programs = [ComputeBudgetProgram.programId.toBase58(), MEMO_PROGRAM_ID];
const supportedPrograms = [...requiredTransferPrograms, ...x402Programs];
const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const assetSchema = z.enum(["USDC", "USDT"]);
const agentPolicySchema = z.object({
  maxAction: amountSchema,
  dailyBudget: amountSchema,
  allowedAssets: z.array(assetSchema).min(1).max(2),
  allowedPrograms: z.array(z.string().min(32).max(44)).min(2).max(4).default(supportedPrograms),
  allowedX402Hosts: z.array(z.string().min(1).max(253)).max(50).default([]),
  expiresAt: z.coerce.date(),
});

function canonicalWallet(value: string) {
  try { return new PublicKey(value).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
}

function toAtomic(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return amount;
}

function resolveAgentPolicy(value: unknown) {
  const input = agentPolicySchema.parse(value);
  const maxAction = toAtomic(input.maxAction);
  const dailyBudget = toAtomic(input.dailyBudget);
  if (dailyBudget < maxAction) throw new ApiError(400, "invalid_budget", "The daily budget must cover at least one maximum-size action.");
  if (input.expiresAt <= new Date() || input.expiresAt.getTime() > Date.now() + 365 * 86_400_000) {
    throw new ApiError(400, "invalid_expiry", "Choose an expiry within the next 365 days.");
  }
  if (new Set(input.allowedAssets).size !== input.allowedAssets.length) throw new ApiError(400, "duplicate_asset", "Each asset can appear only once.");
  const mintMap = { USDC: config.USDC_MINT, USDT: config.USDT_MINT };
  const allowedMints = input.allowedAssets.map((asset) => {
    const mint = mintMap[asset];
    if (!mint) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
    return canonicalWallet(mint);
  });
  const allowedPrograms = input.allowedPrograms.map(canonicalWallet);
  if (new Set(allowedPrograms).size !== allowedPrograms.length
    || allowedPrograms.some((program) => !supportedPrograms.includes(program))) {
    throw new ApiError(400, "unsupported_program", "Agent accounts can authorize only supported token transfer and x402 programs.");
  }
  if (!requiredTransferPrograms.every((program) => allowedPrograms.includes(program))) {
    throw new ApiError(400, "required_program_missing", "SPL transfers require both the Token and Associated Token programs in the allowlist.");
  }
  const allowedX402Hosts = [...new Set(input.allowedX402Hosts.map((raw) => {
    const host = domainToASCII(raw.trim().toLowerCase().replace(/\.$/, ""));
    if (!host || host.length > 253 || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new ApiError(400, "invalid_x402_host", "x402 hosts must be exact public DNS hostnames without a scheme, port, path, or wildcard.");
    }
    return host;
  }))];
  if (allowedX402Hosts.length && !x402Programs.every((program) => allowedPrograms.includes(program))) {
    throw new ApiError(400, "x402_program_missing", "x402 access requires Compute Budget and Memo programs in the agent account allowlist.");
  }
  return { input, maxAction, dailyBudget, allowedMints, allowedPrograms, allowedX402Hosts };
}

function hashAgentToken(token: string) {
  return createHash("sha256").update(config.AUTH_TOKEN_PEPPER || config.DATA_ENCRYPTION_KEY)
    .update(":guildhall-agent:").update(token).digest("hex");
}

declare global {
  namespace Express {
    interface Request {
      agentAccount?: { id: string; ownerUserId: string; publicKey: string };
    }
  }
}

async function requireAgentAccount(request: Request, _response: Response, next: NextFunction) {
  try {
    const token = request.header("authorization")?.match(/^Bearer\s+(gh_agent_[A-Za-z0-9_-]+)$/i)?.[1];
    if (!token) throw new ApiError(401, "agent_token_required", "A GuildHall agent API key is required.");
    const result = await pool.query<{ id: string; owner_user_id: string; public_key: string }>(
      `SELECT a.id, a.owner_user_id, a.public_key
         FROM agent_api_keys k JOIN agent_accounts a ON a.id = k.account_id
        WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND a.disabled_at IS NULL AND a.expires_at > now()`,
      [hashAgentToken(token)],
    );
    if (!result.rows[0]) throw new ApiError(401, "invalid_agent_token", "The agent API key is revoked, expired, or invalid.");
    request.agentAccount = { id: result.rows[0].id, ownerUserId: result.rows[0].owner_user_id, publicKey: result.rows[0].public_key };
    await pool.query("UPDATE agent_api_keys SET last_used_at = now() WHERE token_hash = $1", [hashAgentToken(token)]);
    next();
  } catch (error) {
    next(error);
  }
}

async function ownedAccount(userId: string) {
  const result = await pool.query<{
    id: string; public_key: string; max_action_atomic: string; daily_budget_atomic: string;
    allowed_mints: string[]; allowed_programs: string[]; allowed_x402_hosts: string[]; expires_at: Date;
    disabled_at: Date | null; created_at: Date;
  }>(
    `SELECT id, public_key, max_action_atomic, daily_budget_atomic, allowed_mints, allowed_programs, allowed_x402_hosts,
            expires_at, disabled_at, created_at FROM agent_accounts WHERE owner_user_id = $1`, [userId],
  );
  return result.rows[0] ?? null;
}

agentAccountsRouter.post("/", requireAuth, async (request, response) => {
  const { input, maxAction, dailyBudget, allowedMints, allowedPrograms, allowedX402Hosts } = resolveAgentPolicy(request.body);
  const wallet = createEncryptedSolanaWallet();
  const client = await pool.connect();
  let inserted: { id: string } | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-owner:${request.auth!.userId}`]);
    const existing = await client.query("SELECT 1 FROM agent_accounts WHERE owner_user_id = $1", [request.auth!.userId]);
    if (existing.rowCount) throw new ApiError(409, "agent_account_exists", "This owner already has an agent account.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_accounts
       (owner_user_id, public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag,
        encryption_key_version, cluster, max_action_atomic, daily_budget_atomic, allowed_mints,
        allowed_programs, expires_at, allowed_x402_hosts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [request.auth!.userId, wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce,
        wallet.encryptionAuthTag, wallet.encryptionKeyVersion, config.SOLANA_CLUSTER,
        maxAction.toString(), dailyBudget.toString(), allowedMints, allowedPrograms, input.expiresAt, allowedX402Hosts],
    );
    inserted = result.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  response.status(201).json({ data: { id: inserted!.id, publicKey: wallet.publicKey,
    maxActionAtomic: maxAction.toString(), dailyBudgetAtomic: dailyBudget.toString(),
    allowedMints, allowedPrograms, allowedX402Hosts, expiresAt: input.expiresAt, disabled: false } });
});

agentAccountsRouter.get("/me", requireAuth, async (request, response) => {
  const account = await ownedAccount(request.auth!.userId);
  if (!account) { response.json({ data: null }); return; }
  const usage = await pool.query<{ spent_atomic: string }>(
    "SELECT spent_atomic FROM agent_daily_spend WHERE account_id = $1 AND usage_date = (now() AT TIME ZONE 'UTC')::date", [account.id],
  );
  response.json({ data: {
    id: account.id, publicKey: account.public_key, maxActionAtomic: account.max_action_atomic,
    dailyBudgetAtomic: account.daily_budget_atomic, spentTodayAtomic: usage.rows[0]?.spent_atomic ?? "0",
    allowedMints: account.allowed_mints, allowedPrograms: account.allowed_programs,
    allowedX402Hosts: account.allowed_x402_hosts,
    expiresAt: account.expires_at, disabledAt: account.disabled_at, createdAt: account.created_at,
  } });
});

agentAccountsRouter.put("/me/policy", requireAuth, async (request, response) => {
  const { input, maxAction, dailyBudget, allowedMints, allowedPrograms, allowedX402Hosts } = resolveAgentPolicy(request.body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-owner:${request.auth!.userId}`]);
    const account = await db.query<{ id: string }>(
      "SELECT id FROM agent_accounts WHERE owner_user_id = $1", [request.auth!.userId],
    );
    if (!account.rows[0]) throw new ApiError(404, "agent_account_not_found", "Create an agent account before changing its policy.");
    const accountId = account.rows[0].id;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${accountId}`]);
    await db.query("SELECT id FROM agent_accounts WHERE id = $1 FOR UPDATE", [accountId]);
    const inFlight = await db.query(
      `SELECT 1 FROM agent_transfer_operations WHERE account_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown')
       UNION ALL
       SELECT 1 FROM agent_x402_requests WHERE account_id = $1 AND state = 'prepared'
       LIMIT 1`, [accountId],
    );
    if (inFlight.rowCount) throw new ApiError(409, "agent_operations_in_progress", "Wait for active agent transfers and x402 requests to resolve before changing account policy.");
    await db.query(
      `UPDATE agent_accounts SET max_action_atomic = $2, daily_budget_atomic = $3,
         allowed_mints = $4, allowed_programs = $5, allowed_x402_hosts = $6,
         expires_at = $7, updated_at = now() WHERE id = $1`,
      [accountId, maxAction.toString(), dailyBudget.toString(), allowedMints, allowedPrograms,
        allowedX402Hosts, input.expiresAt],
    );
    await db.query("COMMIT");
    response.json({ data: { id: accountId, maxActionAtomic: maxAction.toString(),
      dailyBudgetAtomic: dailyBudget.toString(), allowedMints, allowedPrograms,
      allowedX402Hosts, expiresAt: input.expiresAt } });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
});

agentAccountsRouter.post("/me/api-keys", requireAuth, async (request, response) => {
  const { label } = z.object({ label: z.string().trim().min(1).max(80).default("agent") }).parse(request.body ?? {});
  const account = await ownedAccount(request.auth!.userId);
  if (!account) throw new ApiError(404, "agent_account_not_found", "Create an agent account first.");
  if (account.disabled_at || account.expires_at <= new Date()) throw new ApiError(409, "agent_account_inactive", "Enable the unexpired agent account before issuing a key.");
  const token = `gh_agent_${randomBytes(32).toString("base64url")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${account.id}`]);
    const current = await client.query<{ disabled_at: Date | null; expires_at: Date }>(
      "SELECT disabled_at, expires_at FROM agent_accounts WHERE id = $1 FOR UPDATE", [account.id],
    );
    if (!current.rows[0] || current.rows[0].disabled_at || current.rows[0].expires_at <= new Date()) {
      throw new ApiError(409, "agent_account_inactive", "Enable the unexpired agent account before issuing a key.");
    }
    const activeKeys = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM agent_api_keys WHERE account_id = $1 AND revoked_at IS NULL", [account.id],
    );
    if (activeKeys.rows[0].count >= 5) throw new ApiError(409, "agent_key_limit", "Revoke an existing key before issuing another.");
    const issued = await client.query<{ id: string }>("INSERT INTO agent_api_keys (account_id, token_hash, label) VALUES ($1, $2, $3) RETURNING id",
      [account.id, hashAgentToken(token), label]);
    await client.query("COMMIT");
    response.status(201).json({ data: { id: issued.rows[0].id, token, label,
      warning: "This key is shown once. Store it securely and send it only from the agent runtime." } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

agentAccountsRouter.delete("/me/api-keys/:keyId", requireAuth, async (request, response) => {
  const keyId = z.string().uuid().parse(request.params.keyId);
  const result = await pool.query(
    `UPDATE agent_api_keys k SET revoked_at = now()
       FROM agent_accounts a WHERE k.id = $1 AND k.account_id = a.id AND a.owner_user_id = $2
         AND k.revoked_at IS NULL RETURNING k.id`, [keyId, request.auth!.userId],
  );
  if (!result.rowCount) throw new ApiError(404, "agent_key_not_found", "Active agent API key not found.");
  response.json({ data: { id: keyId, revoked: true } });
});

agentAccountsRouter.post("/me/kill-switch", requireAuth, async (request, response) => {
  const account = await ownedAccount(request.auth!.userId);
  if (!account) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${account.id}`]);
    await client.query("UPDATE agent_accounts SET disabled_at = now(), updated_at = now() WHERE id = $1", [account.id]);
    await client.query("UPDATE agent_api_keys SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL", [account.id]);
    await client.query("COMMIT");
    response.json({ data: { id: account.id, disabled: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

agentAccountsRouter.post("/me/enable", requireAuth, async (request, response) => {
  const prior = await pool.query<{ id: string }>("SELECT id FROM agent_accounts WHERE owner_user_id = $1", [request.auth!.userId]);
  if (!prior.rows[0]) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${prior.rows[0].id}`]);
    const account = await client.query<{ id: string; expires_at: Date }>(
      "SELECT id, expires_at FROM agent_accounts WHERE owner_user_id = $1 FOR UPDATE", [request.auth!.userId],
    );
    if (!account.rows[0]) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
    if (account.rows[0].expires_at <= new Date()) throw new ApiError(409, "agent_account_expired", "This agent account has expired and cannot be re-enabled.");
    await client.query("UPDATE agent_accounts SET disabled_at = NULL, updated_at = now() WHERE id = $1", [account.rows[0].id]);
    await client.query("COMMIT");
    response.json({ data: { id: account.rows[0].id, enabled: true, issueNewAgentKey: true } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

agentAccountsRouter.post("/:accountId/transfers", requireAgentAccount, async (request, response) => {
  const accountId = z.string().uuid().parse(request.params.accountId);
  if (request.agentAccount!.id !== accountId) throw new ApiError(403, "agent_account_mismatch", "This API key belongs to a different agent account.");
  const input = z.object({ asset: assetSchema, amount: amountSchema, destinationWallet: z.string().min(32).max(44) }).parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const mint = input.asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!mint) throw new ApiError(503, "asset_unavailable", `${input.asset} is not configured for this cluster.`);
  const result = await submitAgentTransfer(accountId, idempotencyKey, {
    mint: canonicalWallet(mint), amountAtomic: toAtomic(input.amount).toString(),
    destinationWallet: canonicalWallet(input.destinationWallet),
  });
  response.status(result.state === "confirmed" ? 200 : 202).json({ data: result });
});

const networkByCluster: Record<string, `${string}:${string}` | undefined> = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
const ip4Private = (address: string) => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224
    || (a === 198 && (b === 18 || b === 19));
};
function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return !ip4Private(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? !ip4Private(mapped[1]) : true;
}
async function assertPublicX402Host(host: string) {
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ApiError(400, "x402_host_forbidden", "x402 requests must use a public DNS hostname.");
  }
  let addresses: LookupAddress[];
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new ApiError(422, "x402_host_unresolved", "The approved x402 hostname does not resolve."); }
  const ipv4Addresses = addresses.filter((entry) => entry.family === 4);
  if (!ipv4Addresses.length || ipv4Addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ApiError(400, "x402_host_forbidden", "The approved x402 hostname resolves to a non-public address.");
  }
  return ipv4Addresses;
}
async function fetchPinnedHttps(resource: RequestInfo | URL, init: RequestInit | undefined, host: string,
  idempotencyKey: string): Promise<globalThis.Response> {
  const outbound = new Request(resource, init);
  const target = new URL(outbound.url);
  if (!["GET", "POST"].includes(outbound.method) || target.hostname !== host || target.protocol !== "https:") {
    throw new Error("x402 requests must remain GET or POST requests to the approved HTTPS host.");
  }
  const addresses = await assertPublicX402Host(host);
  const firstAddress = addresses[0];
  const headers = Object.fromEntries(outbound.headers.entries());
  headers["idempotency-key"] = idempotencyKey;
  const body = outbound.body ? Buffer.from(await outbound.arrayBuffer()) : undefined;
  if (body && body.byteLength > 65_536) throw new Error("x402 JSON request body exceeds 64 KiB.");
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(target, {
      method: outbound.method, headers, servername: host,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, addresses);
        else callback(null, firstAddress.address, firstAddress.family);
      },
    }, (upstream) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((part) => responseHeaders.append(name, part));
        else responseHeaders.set(name, value);
      }
      const status = upstream.statusCode ?? 502;
      const responseBody = [204, 205, 304].includes(status)
        ? null : Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>;
      resolve(new globalThis.Response(responseBody, { status, statusText: upstream.statusMessage, headers: responseHeaders }));
    });
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("x402 upstream timeout.")));
    const abort = () => outgoing.destroy(new Error("x402 request aborted."));
    if (outbound.signal.aborted) abort();
    else outbound.signal.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => outbound.signal.removeEventListener("abort", abort));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
type X402SavedResponse = { bodyBase64: string; truncated: boolean; paymentResponse?: string };
type AgentX402Account = {
  public_key: string; owner_user_id: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
  encryption_auth_tag: Buffer; encryption_key_version: number; cluster: string; max_action_atomic: string;
  daily_budget_atomic: string; allowed_mints: string[]; allowed_x402_hosts: string[]; expires_at: Date; disabled_at: Date | null;
};
async function readLimitedResponse(response: globalThis.Response) {
  const reader = response.body?.getReader();
  if (!reader) return { bodyBase64: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = 1_048_576 - size;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, Math.max(remaining, 0)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { bodyBase64: body.toString("base64"), truncated };
}

agentAccountsRouter.post("/:accountId/x402", requireAgentAccount, async (request, response) => {
  const accountId = z.string().uuid().parse(request.params.accountId);
  if (request.agentAccount!.id !== accountId) throw new ApiError(403, "agent_account_mismatch", "This API key belongs to a different agent account.");
  const input = z.object({
    url: z.string().url(), maxPayment: amountSchema, method: z.enum(["GET", "POST"]).default("GET"),
    body: z.record(z.string(), z.unknown()).optional(),
  }).parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const parsedUrl = new URL(input.url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.port
    || parsedUrl.hash || parsedUrl.search.length > 4096) {
    throw new ApiError(400, "invalid_x402_url", "x402 requests require an HTTPS URL without credentials, a custom port, or a fragment.");
  }
  if (input.method === "GET" && input.body !== undefined) throw new ApiError(400, "invalid_x402_body", "GET x402 requests cannot include a body.");
  if (input.method === "POST" && input.body === undefined) throw new ApiError(400, "invalid_x402_body", "POST x402 requests require a JSON object body.");
  const bodyJson = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (bodyJson !== undefined && Buffer.byteLength(bodyJson) > 65_536) throw new ApiError(413, "x402_body_too_large", "x402 JSON request bodies are limited to 64 KiB.");
  const host = domainToASCII(parsedUrl.hostname.toLowerCase().replace(/\.$/, ""));
  if (!host) throw new ApiError(400, "invalid_x402_url", "The x402 request hostname is invalid.");
  const requestUrlHash = createHash("sha256").update(JSON.stringify({
    url: parsedUrl.toString(), method: input.method, body: bodyJson ?? null,
  })).digest("hex");
  const capAtomic = toAtomic(input.maxPayment);
  const existing = await pool.query<{
    id: string; request_url_hash: string; state: string; response_status: number | null; charged_atomic: string | null;
    reserved_atomic: string;
    response_content_type: string | null; response_ciphertext: Buffer | null; response_nonce: Buffer | null;
    response_auth_tag: Buffer | null; response_key_version: number | null; failure_code: string | null;
  }>(`SELECT id, request_url_hash, reserved_atomic::text, charged_atomic::text, state, response_status, response_content_type, response_ciphertext,
             response_nonce, response_auth_tag, response_key_version, failure_code
        FROM agent_x402_requests WHERE account_id = $1 AND idempotency_key = $2`, [accountId, idempotencyKey]);
  if (existing.rows[0]) {
    const saved = existing.rows[0];
    if (saved.request_url_hash !== requestUrlHash || BigInt(saved.reserved_atomic) !== capAtomic) {
      throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used with different x402 request parameters.");
    }
    if (saved.state === "prepared") throw new ApiError(409, "x402_outcome_unknown", "The prior request may have paid but its result was not confirmed; it will not be retried automatically.");
    if (saved.state === "failed") throw new ApiError(409, saved.failure_code ?? "x402_request_failed", "This x402 request failed; use a new Idempotency-Key after reviewing the outcome.");
    const payload = saved.response_ciphertext && saved.response_nonce && saved.response_auth_tag && saved.response_key_version
      ? decryptPrivateData<X402SavedResponse>({ ciphertext: saved.response_ciphertext, nonce: saved.response_nonce,
        authTag: saved.response_auth_tag, keyVersion: saved.response_key_version }) : null;
    response.status(saved.state === "outcome_unknown" ? 202 : saved.response_status ?? 502).json({ data: {
      id: saved.id, state: saved.state, status: saved.response_status, chargedAtomic: saved.charged_atomic,
      contentType: saved.response_content_type, ...(payload ?? {}), idempotentReplay: true,
    } });
    return;
  }
  await assertPublicX402Host(host);

  const db = await pool.connect();
  let account: AgentX402Account | undefined;
  let usageDate = "";
  let requestId = "";
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${accountId}`]);
    const raced = await db.query("SELECT 1 FROM agent_x402_requests WHERE account_id = $1 AND idempotency_key = $2", [accountId, idempotencyKey]);
    if (raced.rowCount) throw new ApiError(409, "x402_request_in_progress", "A request with this Idempotency-Key is already being processed or awaiting outcome review.");
    const selected = await db.query<AgentX402Account>(
      `SELECT a.*, u.wallet_address AS owner_wallet FROM agent_accounts a
         JOIN wallet_users u ON u.id = a.owner_user_id WHERE a.id = $1 FOR UPDATE OF a`, [accountId]);
    account = selected.rows[0];
    if (!account || account.disabled_at || account.expires_at <= new Date()) throw new ApiError(409, "agent_account_inactive", "This agent account is disabled or expired.");
    if (!account.allowed_x402_hosts.includes(host)) throw new ApiError(403, "x402_host_not_allowed", "This hostname is not in the agent account's approved x402 host list.");
    if (!networkByCluster[account.cluster]) throw new ApiError(409, "x402_cluster_unsupported", "x402 payments are enabled only on Solana mainnet and devnet.");
    if (capAtomic > BigInt(account.max_action_atomic)) throw new ApiError(409, "action_limit_exceeded", "This maximum payment exceeds the agent account's per-action limit.");
    await db.query("INSERT INTO agent_daily_spend (account_id, usage_date, spent_atomic) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 0) ON CONFLICT DO NOTHING", [accountId]);
    const spend = await db.query<{ usage_date: string; spent_atomic: string }>(
      "SELECT usage_date::text, spent_atomic FROM agent_daily_spend WHERE account_id = $1 AND usage_date = (now() AT TIME ZONE 'UTC')::date FOR UPDATE", [accountId]);
    if (BigInt(spend.rows[0].spent_atomic) + capAtomic > BigInt(account.daily_budget_atomic)) throw new ApiError(409, "daily_budget_exceeded", "Reserving this x402 maximum would exceed the agent account's daily budget.");
    usageDate = spend.rows[0].usage_date;
    await db.query("UPDATE agent_daily_spend SET spent_atomic = spent_atomic + $3::numeric, updated_at = now() WHERE account_id = $1 AND usage_date = $2::date", [accountId, usageDate, capAtomic.toString()]);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO agent_x402_requests (account_id, idempotency_key, request_url_hash, request_host, request_method, reserved_atomic)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [accountId, idempotencyKey, requestUrlHash, host, input.method, capAtomic.toString()]);
    requestId = inserted.rows[0].id;
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }

  let selectedRequirement: { amount: string; asset: string; network: string; payTo: string } | undefined;
  let finalResponse: globalThis.Response | undefined;
  let body: X402SavedResponse | undefined;
  let failure: unknown;
  try {
    const network = networkByCluster[account!.cluster]!;
    const secret = decryptSolanaSecretKey({ ciphertext: account!.encrypted_secret_key, nonce: account!.encryption_nonce,
      authTag: account!.encryption_auth_tag, keyVersion: account!.encryption_key_version });
    const signer = await createKeyPairSignerFromBytes(secret);
    const client = new x402Client().register(network, new ExactSvmScheme(signer, { rpcUrl: config.SOLANA_RPC_URL }))
      .setSpendControls(false)
      .registerPolicy((_version, requirements) => {
        const eligible = requirements.filter((requirement) => {
          if (requirement.scheme !== "exact" || requirement.network !== network
            || !account!.allowed_mints.includes(requirement.asset)) return false;
          try { return BigInt(requirement.amount) > 0n && BigInt(requirement.amount) <= capAtomic; }
          catch { return false; }
        }).sort((left, right) => {
          const a = BigInt(left.amount); const b = BigInt(right.amount);
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const selected = eligible[0];
        if (selected) selectedRequirement = { amount: selected.amount, asset: selected.asset,
          network: selected.network, payTo: selected.payTo };
        return selected ? [selected] : [];
      });
    const safeFetch = async (resource: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response> => {
      const target = new URL(resource instanceof Request ? resource.url : resource.toString());
      if (target.hostname !== host || target.protocol !== "https:" || (init?.redirect && init.redirect !== "manual")) {
        throw new Error("x402 redirect or destination is outside the approved host.");
      }
      const headers = new Headers(resource instanceof Request ? resource.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      if (input.method === "POST") headers.set("content-type", "application/json");
      return fetchPinnedHttps(resource, { ...init, method: input.method, redirect: "manual",
        ...(input.method === "POST" ? { body: bodyJson } : {}), headers,
        signal: AbortSignal.timeout(30_000) }, host, idempotencyKey);
    };
    const paidFetch = wrapFetchWithPayment(safeFetch as unknown as typeof fetch, client);
    finalResponse = await paidFetch(parsedUrl.toString(), { method: input.method, redirect: "manual",
      ...(input.method === "POST" ? { body: bodyJson, headers: { "content-type": "application/json", "idempotency-key": idempotencyKey } } : {}) });
    if (selectedRequirement) {
      await pool.query(`UPDATE agent_x402_requests SET payment_mint = $2, payment_network = $3,
          payment_recipient = $4 WHERE id = $1`,
      [requestId, selectedRequirement.asset, selectedRequirement.network, selectedRequirement.payTo]);
    }
    body = { ...await readLimitedResponse(finalResponse),
      ...(finalResponse.headers.get("payment-response") ? { paymentResponse: finalResponse.headers.get("payment-response")! } : {}) };
  } catch (error) { failure = error; }

  const charged = selectedRequirement ? BigInt(selectedRequirement.amount) : 0n;
  if (failure) {
    const chargedAtomic = charged.toString();
    if (charged > 0n) {
      await pool.query(`UPDATE agent_x402_requests SET state = 'outcome_unknown', charged_atomic = $2,
        failure_code = 'upstream_outcome_unknown', updated_at = now() WHERE id = $1`, [requestId, chargedAtomic]);
      await pool.query(`UPDATE agent_daily_spend SET spent_atomic = spent_atomic - ($3::numeric - $4::numeric), updated_at = now()
        WHERE account_id = $1 AND usage_date = $2::date`, [accountId, usageDate, capAtomic.toString(), chargedAtomic]);
      throw new ApiError(502, "x402_outcome_unknown", "The upstream result was interrupted after payment may have been authorized; this request will not be repeated.");
    }
    await pool.query(`UPDATE agent_x402_requests SET state = 'failed', charged_atomic = 0,
      failure_code = 'upstream_request_failed', updated_at = now() WHERE id = $1`, [requestId]);
    await pool.query(`UPDATE agent_daily_spend SET spent_atomic = spent_atomic - $3::numeric, updated_at = now()
      WHERE account_id = $1 AND usage_date = $2::date`, [accountId, usageDate, capAtomic.toString()]);
    throw new ApiError(502, "x402_request_failed", "The upstream x402 request failed before a payment requirement was selected.");
  }

  const savedResponse = encryptPrivateData(body!);
  const hasPaymentReceipt = finalResponse!.headers.has("payment-response");
  const state = selectedRequirement && hasPaymentReceipt ? "succeeded"
    : selectedRequirement ? "outcome_unknown" : "unpaid";
  await pool.query(`UPDATE agent_x402_requests SET state = $2, charged_atomic = $3,
    response_status = $4, response_content_type = $5, response_ciphertext = $6,
    response_nonce = $7, response_auth_tag = $8, response_key_version = $9, updated_at = now()
    WHERE id = $1`, [requestId, state, charged.toString(), finalResponse!.status,
    finalResponse!.headers.get("content-type")?.slice(0, 255) ?? null, savedResponse.ciphertext,
    savedResponse.nonce, savedResponse.authTag, savedResponse.keyVersion]);
  if (charged < capAtomic) await pool.query(`UPDATE agent_daily_spend SET spent_atomic = spent_atomic - ($3::numeric - $4::numeric), updated_at = now()
    WHERE account_id = $1 AND usage_date = $2::date`, [accountId, usageDate, capAtomic.toString(), charged.toString()]);
  response.status(state === "outcome_unknown" ? 202 : 200).json({ data: { id: requestId, state, status: finalResponse!.status,
    contentType: finalResponse!.headers.get("content-type"), ...body, chargedAtomic: charged.toString(),
    mint: selectedRequirement?.asset ?? null, network: selectedRequirement?.network ?? null,
    paymentResponse: finalResponse!.headers.get("payment-response") } });
});

agentAccountsRouter.get("/me/transfers", requireAuth, async (request, response) => {
  const account = await ownedAccount(request.auth!.userId);
  if (!account) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
  const result = await pool.query(
    `SELECT id, mint, amount_atomic, destination_wallet, state, transaction_signature,
            failure_code, created_at, updated_at
       FROM agent_transfer_operations WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`, [account.id],
  );
  response.json({ data: result.rows });
});

agentAccountsRouter.get("/me/x402-requests", requireAuth, async (request, response) => {
  const account = await ownedAccount(request.auth!.userId);
  if (!account) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
  const result = await pool.query(
    `SELECT id, request_host, reserved_atomic::text AS reserved_atomic,
            charged_atomic::text AS charged_atomic, payment_mint, payment_network, payment_recipient,
            state, response_status, failure_code, created_at, updated_at
       FROM agent_x402_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`, [account.id],
  );
  response.json({ data: result.rows });
});

export async function reconcileAgentX402Requests(limit: number) {
  const result = await pool.query<{ id: string }>(
    `WITH expired AS (
       SELECT id FROM agent_x402_requests WHERE state = 'prepared'
         AND created_at < now() - interval '2 minutes'
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_x402_requests r SET state = 'outcome_unknown', failure_code = 'request_interrupted', updated_at = now()
       FROM expired WHERE r.id = expired.id RETURNING r.id`, [limit],
  );
  return { markedUnknown: result.rowCount ?? 0 };
}

agentAccountsRouter.post("/me/recover", requireAuth, async (request, response) => {
  const account = await ownedAccount(request.auth!.userId);
  if (!account) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
  const input = z.object({ asset: assetSchema, amount: amountSchema }).parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const mint = input.asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!mint) throw new ApiError(503, "asset_unavailable", `${input.asset} is not configured for this cluster.`);
  const result = await submitAgentTransfer(account.id, idempotencyKey, {
    mint: canonicalWallet(mint), amountAtomic: toAtomic(input.amount).toString(),
    destinationWallet: request.auth!.walletAddress,
  }, true);
  response.status(result.state === "confirmed" ? 200 : 202).json({ data: result });
});
