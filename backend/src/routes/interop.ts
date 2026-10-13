import { Router } from "express";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { createCommissionEscrowWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { assertSafeTaskText, taskSafetyAttestation } from "../task-policy.js";

export const interopRouter = Router();
const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);

function mintFor(asset: "USDC" | "USDT") {
  const value = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!value) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try { return new PublicKey(value).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid mint configuration.`); }
}

function atomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (result <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return result.toString();
}

function canonicalWallet(value: string | undefined) {
  if (!value) return null;
  try { return new PublicKey(value).toBase58(); }
  catch { throw new ApiError(400, "invalid_provider_wallet", "Provider wallet must be a valid Solana address."); }
}

interopRouter.post("/jobs", requireAuth, async (request, response) => {
  const input = z.object({
    source: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_.-]*$/i),
    externalJobId: z.string().trim().min(1).max(200),
    sourceUrl: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    }).optional(),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(20_000),
    asset: z.enum(["USDC", "USDT"]),
    amount: amountSchema,
    category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i).default("general"),
    slaHours: z.number().int().min(1).max(8760).optional(),
    providerWallet: z.string().min(32).max(44).optional(),
    deadlineAt: z.coerce.date().optional(),
    safetyAttestation: taskSafetyAttestation,
  }).parse(request.body);
  assertSafeTaskText(input.title, input.description);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const providerWallet = canonicalWallet(input.providerWallet);
  const mint = mintFor(input.asset);
  const amountAtomic = atomic(input.amount);
  const sourceUrl = input.sourceUrl ? new URL(input.sourceUrl).toString() : null;
  if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now() + 60_000) throw new ApiError(400, "invalid_deadline", "The deadline must be at least one minute in the future.");
  const deadlineAt = input.deadlineAt ?? new Date(Date.now() + (input.slaHours ?? 168) * 60 * 60 * 1000);
  const source = input.source.toLowerCase();
  const externalJobId = input.externalJobId.trim();
  const scopedKey = `interop:${source}:${idempotencyKey}`;
  const requestHash = createHash("sha256").update(JSON.stringify({
    source, externalJobId, sourceUrl, title: input.title,
    description: input.description, asset: input.asset, mint, amountAtomic,
    category: input.category, slaHours: input.slaHours ?? null, providerWallet,
    requestedDeadlineAt: input.deadlineAt?.toISOString() ?? null,
  })).digest("hex");
  const client = await pool.connect();
  let commissionId: string;
  let replay = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [source, externalJobId]);
    const bySource = await client.query<{ commission_id: string; client_user_id: string; request_hash: string | null }>(
      `SELECT i.commission_id, c.client_user_id, c.request_hash
         FROM interop_job_imports i JOIN commissions c ON c.id = i.commission_id
        WHERE i.source = $1 AND i.external_job_id = $2 FOR UPDATE OF i, c`, [source, externalJobId],
    );
    if (bySource.rows[0]) {
      const prior = bySource.rows[0];
      if (prior.client_user_id !== request.auth!.userId || prior.request_hash !== requestHash) {
        throw new ApiError(409, "interop_job_conflict", "This external job has already been imported with different terms.");
      }
      commissionId = prior.commission_id;
      replay = true;
      await client.query("COMMIT");
    } else {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [request.auth!.userId, scopedKey]);
      const existing = await client.query<{ id: string; request_hash: string | null }>(
        "SELECT id, request_hash FROM commissions WHERE client_user_id = $1 AND idempotency_key = $2",
        [request.auth!.userId, scopedKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different imported job terms.");
        commissionId = existing.rows[0].id;
        replay = true;
        await client.query("COMMIT");
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO commissions
             (client_user_id, client_wallet, provider_wallet, title, description, asset_mint,
              amount_atomic, status, deadline_at, idempotency_key, request_hash, work_category,
              sla_hours, work_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12, 'interop')
           RETURNING id`,
          [request.auth!.userId, request.auth!.walletAddress, providerWallet, input.title,
            input.description, mint, amountAtomic, deadlineAt, scopedKey, requestHash,
            input.category, input.slaHours ?? null],
        );
        commissionId = inserted.rows[0].id;
        await createCommissionEscrowWallet(client, commissionId);
        await client.query(
          `INSERT INTO interop_job_imports (commission_id, source, external_job_id, source_url, imported_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [commissionId, source, externalJobId, sourceUrl, request.auth!.userId],
        );
        await client.query("COMMIT");
      }
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  const result = await pool.query<{
    id: string; title: string; description: string; client_wallet: string; provider_wallet: string | null;
    asset_mint: string; amount_atomic: string; status: string; deadline_at: Date; work_category: string;
    sla_hours: number | null; escrow_address: string; source: string; external_job_id: string;
  }>(
    `SELECT c.id, c.title, c.description, c.client_wallet, c.provider_wallet, c.asset_mint,
            c.amount_atomic::text, c.status, c.deadline_at, c.work_category, c.sla_hours,
            w.public_key AS escrow_address, i.source, i.external_job_id
       FROM commissions c JOIN commission_escrow_wallets w ON w.commission_id = c.id
       JOIN interop_job_imports i ON i.commission_id = c.id WHERE c.id = $1`, [commissionId!],
  );
  const row = result.rows[0];
  response.status(replay ? 200 : 201).json({
    data: { id: row.id, title: row.title, description: row.description, clientWallet: row.client_wallet,
      providerWallet: row.provider_wallet, assetMint: row.asset_mint, amountAtomic: row.amount_atomic,
      status: row.status, workType: "interop", category: row.work_category, slaHours: row.sla_hours,
      deadlineAt: row.deadline_at, escrowAddress: row.escrow_address,
      source: row.source, externalJobId: row.external_job_id },
    fundingInstructions: `/v1/commissions/${row.id}/funding-instructions`,
    idempotentReplay: replay,
  });
});

interopRouter.get("/jobs/:id", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const result = await pool.query(
    `SELECT c.id, c.title, c.description, c.client_wallet, c.provider_wallet, c.asset_mint,
            c.amount_atomic::text AS amount_atomic, c.status, c.deadline_at, c.work_category,
            c.sla_hours, w.public_key AS escrow_address, i.source, i.external_job_id, i.source_url
       FROM commissions c JOIN interop_job_imports i ON i.commission_id = c.id
       JOIN commission_escrow_wallets w ON w.commission_id = c.id WHERE c.id = $1`, [id],
  );
  if (!result.rows[0]) throw new ApiError(404, "interop_job_not_found", "Imported marketplace job not found.");
  response.json({ data: { ...result.rows[0], workType: "interop" } });
});

function offerManifest(row: {
  id: string; export_id: string; title: string; description: string; client_wallet: string;
  provider_wallet: string | null; asset_mint: string; amount_atomic: string; status: string;
  deadline_at: Date; work_category: string; sla_hours: number | null; escrow_address: string;
  published_at: Date;
}) {
  const manifest = {
    protocolVersion: "guildhall-interop/v1",
    offerId: row.export_id,
    commissionId: row.id,
    source: "guildhall",
    terms: {
      title: row.title,
      description: row.description,
      clientWallet: row.client_wallet,
      providerWallet: row.provider_wallet,
      assetMint: row.asset_mint,
      amountAtomic: row.amount_atomic,
      status: row.status,
      deadlineAt: row.deadline_at,
      category: row.work_category,
      slaHours: row.sla_hours,
      escrowAddress: row.escrow_address,
      publishedAt: row.published_at,
      routingFeeBasisPoints: 100,
    },
    links: {
      details: `/v1/commissions/${row.id}`,
      fundingInstructions: `/v1/commissions/${row.id}/funding-instructions`,
      accept: `/v1/commissions/${row.id}/accept`,
      submitWork: `/v1/commissions/${row.id}/submissions`,
    },
  };
  return { ...manifest, manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}

interopRouter.get("/offers", async (request, response) => {
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().datetime().optional(),
  }).parse(request.query);
  const result = await pool.query<{
    id: string; export_id: string; title: string; description: string; client_wallet: string;
    provider_wallet: string | null; asset_mint: string; amount_atomic: string; status: string;
    deadline_at: Date; work_category: string; sla_hours: number | null; escrow_address: string;
    published_at: Date;
  }>(
    `SELECT c.id, e.export_id, c.title, c.description, c.client_wallet, c.provider_wallet,
            c.asset_mint, c.amount_atomic::text, c.status, c.deadline_at, c.work_category,
            c.sla_hours, w.public_key AS escrow_address, e.published_at
       FROM interop_job_exports e JOIN commissions c ON c.id = e.commission_id
       JOIN commission_escrow_wallets w ON w.commission_id = c.id
      WHERE e.unpublished_at IS NULL AND c.work_type = 'interop'
        AND c.status IN ('open', 'funded') AND c.accepted_at IS NULL AND c.deadline_at > now()
        AND ($1::timestamptz IS NULL OR e.published_at < $1)
      ORDER BY e.published_at DESC LIMIT $2`, [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows.map(offerManifest) });
});

interopRouter.get("/offers/:id", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const result = await pool.query<{
    id: string; export_id: string; title: string; description: string; client_wallet: string;
    provider_wallet: string | null; asset_mint: string; amount_atomic: string; status: string;
    deadline_at: Date; work_category: string; sla_hours: number | null; escrow_address: string;
    published_at: Date;
  }>(
    `SELECT c.id, e.export_id, c.title, c.description, c.client_wallet, c.provider_wallet,
            c.asset_mint, c.amount_atomic::text, c.status, c.deadline_at, c.work_category,
            c.sla_hours, w.public_key AS escrow_address, e.published_at
       FROM interop_job_exports e JOIN commissions c ON c.id = e.commission_id
       JOIN commission_escrow_wallets w ON w.commission_id = c.id
      WHERE c.id = $1 AND e.unpublished_at IS NULL AND c.work_type = 'interop'`, [id],
  );
  if (!result.rows[0]) throw new ApiError(404, "interop_offer_not_found", "This GuildHall offer is not available in the Interop feed.");
  response.json({ data: offerManifest(result.rows[0]) });
});

interopRouter.post("/offers/:id/publish", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const client = await pool.connect();
  let exportId: string;
  let created = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const commission = await client.query<{
      client_user_id: string; work_type: string; status: string; accepted_at: Date | null;
      funding_signature: string | null; deadline_at: Date;
    }>(
      "SELECT client_user_id, work_type, status, accepted_at, funding_signature, deadline_at FROM commissions WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = commission.rows[0];
    if (!row) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (row.client_user_id !== request.auth!.userId) throw new ApiError(403, "interop_offer_forbidden", "Only the commission client can publish it to the Interop feed.");
    if (!["standard", "interop"].includes(row.work_type) || row.status !== "open"
      || row.accepted_at || row.funding_signature || row.deadline_at <= new Date()) {
      throw new ApiError(409, "interop_offer_not_publishable", "Only an open, unaccepted, unfunded commission can be published to the Interop feed.");
    }
    await client.query("UPDATE commissions SET work_type = 'interop', updated_at = now() WHERE id = $1 AND work_type = 'standard'", [id]);
    const priorExport = await client.query<{ export_id: string; unpublished_at: Date | null }>(
      "SELECT export_id, unpublished_at FROM interop_job_exports WHERE commission_id = $1 FOR UPDATE", [id],
    );
    if (priorExport.rows[0]) {
      exportId = priorExport.rows[0].export_id;
      if (priorExport.rows[0].unpublished_at) {
        await client.query(
          "UPDATE interop_job_exports SET published_at = now(), unpublished_at = NULL WHERE commission_id = $1", [id],
        );
      }
    } else {
      const inserted = await client.query<{ export_id: string }>(
        `INSERT INTO interop_job_exports (commission_id, published_by)
         VALUES ($1, $2) RETURNING export_id`, [id, request.auth!.userId],
      );
      exportId = inserted.rows[0].export_id;
      created = true;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  response.status(created ? 201 : 200).json({ data: { commissionId: id, exportId, protocolVersion: "guildhall-interop/v1", published: true } });
});

interopRouter.post("/offers/:id/unpublish", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const client = await pool.connect();
  let workType = "standard";
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const owner = await client.query<{
      client_user_id: string; work_type: string; status: string;
      accepted_at: Date | null; funding_signature: string | null;
    }>(
      "SELECT client_user_id, work_type, status, accepted_at, funding_signature FROM commissions WHERE id = $1 FOR UPDATE", [id],
    );
    if (!owner.rows[0]) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (owner.rows[0].client_user_id !== request.auth!.userId) {
      throw new ApiError(403, "interop_offer_forbidden", "Only the commission client can unpublish it.");
    }
    await client.query(
      "UPDATE interop_job_exports SET unpublished_at = COALESCE(unpublished_at, now()) WHERE commission_id = $1", [id],
    );
    const imported = await client.query("SELECT 1 FROM interop_job_imports WHERE commission_id = $1", [id]);
    const canReturnToStandard = owner.rows[0].work_type === "interop" && !imported.rowCount
      && owner.rows[0].status === "open" && !owner.rows[0].accepted_at && !owner.rows[0].funding_signature;
    if (canReturnToStandard) {
      await client.query("UPDATE commissions SET work_type = 'standard', updated_at = now() WHERE id = $1", [id]);
      workType = "standard";
    } else {
      workType = owner.rows[0].work_type;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  response.json({ data: { commissionId: id, published: false, workType } });
});
