import { Readable } from "node:stream";
import { Router } from "express";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { resolveWalletSession } from "../auth.js";
import { ApiError } from "../http.js";
import { evidenceItemSchema, submitCommissionWork } from "../commission-work.js";
import { claimCommissionForWallet, commissionCreateInputSchema, createCommissionForWallet, getCommissionFundingInstructions } from "../commission-service.js";
import { commissionReviewInputSchema, reviewCommissionSubmission } from "../commission-review.js";
import { createHandForWallet, handCreateInputSchema } from "../hand-service.js";
import { bountyCreateInputSchema, createBountyForWallet } from "../bounty-service.js";

export const mcpRouter = Router();

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function createGuildhallMcpServer(session: { userId: string; walletAddress: string } | null) {
  const server = new McpServer({ name: "guildhall", version: "1.0.0" });
  const annotations = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("supported_assets", {
    description: "List stablecoin assets enabled for GuildHall on the configured Solana cluster.",
    inputSchema: z.object({}), annotations,
  }, async () => textResult({ cluster: config.SOLANA_CLUSTER, decimals: 6,
    assets: [{ symbol: "USDC", mint: config.USDC_MINT ?? null }, { symbol: "USDT", mint: config.USDT_MINT ?? null }]
      .filter((asset) => asset.mint !== null) }));

  server.registerTool("search_open_commissions", {
    description: "Find open standard and Interop commissions that have not expired. Returns public terms and funding addresses.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(120).optional(),
      category: z.string().trim().min(1).max(80).optional(),
      asset: z.enum(["USDC", "USDT"]).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }), annotations,
  }, async ({ query, category, asset, limit }) => {
    const mint = asset === "USDC" ? config.USDC_MINT : asset === "USDT" ? config.USDT_MINT : null;
    if (asset && !mint) return textResult({ data: [], cluster: config.SOLANA_CLUSTER });
    const term = query ? `%${escapeLike(query)}%` : null;
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.client_wallet AS "clientWallet",
              c.provider_wallet AS "providerWallet", c.asset_mint AS "assetMint",
              c.amount_atomic::text AS "amountAtomic", c.status, c.work_type AS "workType",
              c.work_category AS category, c.sla_hours AS "slaHours", c.deadline_at AS "deadlineAt",
              c.accepted_at AS "acceptedAt", c.funding_signature AS "fundingSignature",
              c.funded_at AS "fundedAt", w.public_key AS "escrowAddress", c.created_at AS "createdAt"
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.status = 'open' AND c.accepted_at IS NULL AND c.work_type IN ('standard', 'interop')
          AND c.deadline_at > now() AND ($1::text IS NULL OR c.title ILIKE $1 ESCAPE '\\' OR c.description ILIKE $1 ESCAPE '\\')
          AND ($2::text IS NULL OR c.work_category = $2)
          AND ($3::text IS NULL OR c.asset_mint = $3)
        ORDER BY c.created_at DESC, c.id DESC LIMIT $4`,
      [term, category ?? null, mint, limit],
    );
    return textResult({ data: result.rows, cluster: config.SOLANA_CLUSTER });
  });

  server.registerTool("get_commission", {
    description: "Read public terms and current status for one GuildHall commission.",
    inputSchema: z.object({ commissionId: z.string().uuid() }), annotations,
  }, async ({ commissionId }) => {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.client_wallet AS "clientWallet",
              c.provider_wallet AS "providerWallet", c.asset_mint AS "assetMint",
              c.amount_atomic::text AS "amountAtomic", c.status, c.work_type AS "workType",
              c.work_category AS category, c.sla_hours AS "slaHours", c.deadline_at AS "deadlineAt",
              c.accepted_at AS "acceptedAt", c.funding_signature AS "fundingSignature",
              c.funded_at AS "fundedAt", w.public_key AS "escrowAddress", c.created_at AS "createdAt"
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.id = $1`, [commissionId],
    );
    return textResult(result.rows[0] ?? { error: "commission_not_found" });
  });

  server.registerTool("commission_funding_instructions", {
    description: "Prepare an unsigned stablecoin funding transaction for an open commission. The client wallet must sign and submit it.",
    inputSchema: z.object({ commissionId: z.string().uuid() }), annotations,
  }, async ({ commissionId }) => {
    if (!session) throw new ApiError(401, "unauthenticated", "Connect a wallet session before preparing commission funding.");
    return textResult({ data: await getCommissionFundingInstructions(commissionId, session.userId) });
  });

  server.registerTool("search_bounties", {
    description: "Find public open or funded Bounties accepting entries before their deadline.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(120).optional(),
      category: z.string().trim().min(1).max(80).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }), annotations,
  }, async ({ query, category, limit }) => {
    const term = query ? `%${escapeLike(query)}%` : null;
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.client_wallet AS "clientWallet",
              c.asset_mint AS "assetMint", c.amount_atomic::text AS "amountAtomic", c.status,
              c.work_category AS category, c.sla_hours AS "slaHours", c.deadline_at AS "deadlineAt",
              b.bond_atomic::text AS "bondAtomic", b.max_entries AS "maxEntries",
              (SELECT count(*)::int FROM bounty_entries e
                WHERE e.commission_id = c.id AND e.bond_confirmed_at IS NOT NULL) AS entrants
         FROM commissions c JOIN bounties b ON b.commission_id = c.id
        WHERE c.work_type = 'bounty' AND c.status IN ('open', 'funded') AND c.deadline_at > now()
          AND ($1::text IS NULL OR c.title ILIKE $1 ESCAPE '\\' OR c.description ILIKE $1 ESCAPE '\\')
          AND ($2::text IS NULL OR c.work_category = $2)
        ORDER BY c.created_at DESC, c.id DESC LIMIT $3`, [term, category ?? null, limit],
    );
    return textResult({ data: result.rows, cluster: config.SOLANA_CLUSTER });
  });

  server.registerTool("search_hands", {
    description: "Find safe, open Human Tasks accepting workers before their deadline, including their required proof schemas.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(120).optional(),
      category: z.enum(["public_place_photo", "inventory_count", "accessibility_observation"]).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }), annotations,
  }, async ({ query, category, limit }) => {
    const term = query ? `%${escapeLike(query)}%` : null;
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.client_wallet AS "clientWallet",
              c.asset_mint AS "assetMint", c.amount_atomic::text AS "amountAtomic", c.status,
              c.category, c.proof_schema AS "proofSchema", c.deadline_at AS "deadlineAt",
              c.sla_hours AS "slaHours", w.public_key AS "escrowAddress", c.created_at AS "createdAt"
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.work_type = 'hand' AND c.status IN ('open', 'funded')
          AND c.provider_user_id IS NULL AND c.deadline_at > now()
          AND ($1::text IS NULL OR c.title ILIKE $1 ESCAPE '\\' OR c.description ILIKE $1 ESCAPE '\\')
          AND ($2::text IS NULL OR c.category = $2)
        ORDER BY c.created_at DESC, c.id DESC LIMIT $3`, [term, category ?? null, limit],
    );
    return textResult({ data: result.rows, cluster: config.SOLANA_CLUSTER });
  });

  server.registerTool("rate_board", {
    description: "Read the latest hourly Rate Board snapshot, calculated only from settled work.",
    inputSchema: z.object({}), annotations,
  }, async () => {
    const result = await pool.query<{ market_data: unknown; guild_data: unknown; refreshed_at: Date }>(
      "SELECT market_data, guild_data, refreshed_at FROM rate_board_snapshots WHERE id = 1",
    );
    return textResult(result.rows[0]
      ? { data: result.rows[0].market_data, guilds: result.rows[0].guild_data, generatedAt: result.rows[0].refreshed_at, basis: "settled escrow work" }
      : { data: [], guilds: [], generatedAt: null, basis: "settled escrow work", status: "snapshot_not_available" });
  });

  if (session) {
    server.registerTool("create_bounty", {
      description: "Create a ranked Bounty with a dedicated commission escrow EOA and a stake-qualified evaluator. Supply an idempotency key and explicitly attest the task is safe.",
      inputSchema: bountyCreateInputSchema.extend({ idempotencyKey: z.string().min(8).max(128) }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ idempotencyKey, ...terms }) => {
      const created = await createBountyForWallet(session.userId, session.walletAddress, terms, idempotencyKey);
      return textResult(created);
    });

    server.registerTool("create_hand", {
      description: "Create a Human Task with a dedicated escrow EOA and category proof schema. Supply an idempotency key and explicitly attest the task is safe.",
      inputSchema: handCreateInputSchema.extend({ idempotencyKey: z.string().min(8).max(128) }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ idempotencyKey, ...handInput }) => {
      return textResult(await createHandForWallet(session, idempotencyKey, handInput));
    });

    server.registerTool("create_commission", {
      description: "Post a commission with a dedicated escrow EOA. The wallet session identifies the client; supply an idempotency key and explicitly attest the task is safe.",
      inputSchema: commissionCreateInputSchema.extend({ idempotencyKey: z.string().min(8).max(128) }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ idempotencyKey, ...commissionInput }) => {
      return textResult(await createCommissionForWallet(session, idempotencyKey, commissionInput));
    });

    server.registerTool("claim_commission", {
      description: "Claim an open or funded non-Bounty commission for the wallet authenticated on this MCP connection.",
      inputSchema: z.object({ commissionId: z.string().uuid() }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ commissionId }) => {
      return textResult({ data: await claimCommissionForWallet(commissionId, session) });
    });

    server.registerTool("submit_commission_work", {
      description: "Submit an encrypted work revision to a commission claimed by the wallet authenticated on this MCP connection.",
      inputSchema: z.object({
        commissionId: z.string().uuid(),
        summary: z.string().trim().min(1).max(5000),
        evidence: z.array(evidenceItemSchema).min(1).max(50),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ commissionId, summary, evidence }) => {
      const submission = await submitCommissionWork(commissionId, session.userId, { summary, evidence });
      return textResult({ data: submission });
    });

    server.registerTool("review_commission_submission", {
      description: "Review the latest submission on a commission owned by the authenticated wallet. Accepting opens the independent Warden sign-off flow; requesting changes returns the commission to funded status; disputing opens Tribunal.",
      inputSchema: commissionReviewInputSchema.extend({ commissionId: z.string().uuid() }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ commissionId, ...review }) => {
      return textResult(await reviewCommissionSubmission(commissionId, session.userId, review));
    });
  }

  return server;
}

mcpRouter.all("/", async (request, response) => {
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    response.setHeader("allow", "GET, POST, DELETE");
    response.status(405).end();
    return;
  }
  const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const session = bearer ? await resolveWalletSession(bearer) : null;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 256 * 1024,
  });
  await createGuildhallMcpServer(session).connect(transport);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const url = new URL(request.originalUrl, `${request.protocol}://${request.get("host") ?? "localhost"}`);
  const init: RequestInit = { method: request.method, headers };
  if (request.method === "POST") init.body = JSON.stringify(request.body ?? {});
  const result = await transport.handleRequest(new Request(url, init),
    request.method === "POST" ? { parsedBody: request.body ?? {} } : undefined);
  response.status(result.status);
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (!result.body) {
    response.end();
    return;
  }
  Readable.fromWeb(result.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>).pipe(response);
});
