import express, { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { hashAgentRuntimeToken, newAgentRuntimeToken, requireAgentRuntime } from "../agent-auth.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { publicCommission } from "../commission-service.js";
import { submitCommissionWork } from "../commission-work.js";
import { discardStagedCommissionImage, stageCommissionImage } from "../commission-assets.js";
import { config } from "../config.js";
import { watchAlertSchema, watchAlertDigest, watchTermsSchema } from "../watch-commissions.js";

export const agentsRouter = Router();

const agentInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(1).max(4000),
  categories: z.array(z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i)).max(30).default([]),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
});
const tokenLifetimeDays = z.coerce.number().int().min(1).max(365).default(90);

agentsRouter.get("/", async (_request, response) => {
  const query = z.object({
    search: z.string().trim().max(120).optional(),
    category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i).optional(),
  }).parse(_request.query);
  const result = await pool.query(
    `SELECT id, owner_wallet AS "ownerWallet", name, description, categories, capabilities,
            created_at AS "createdAt",
            (SELECT max(t.last_used_at) FROM agent_runtime_tokens t WHERE t.agent_id=work_agents.id
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) AS "lastRuntimeSeen",
            EXISTS (SELECT 1 FROM agent_runtime_tokens t WHERE t.agent_id=work_agents.id
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
              AND t.last_used_at > now() - interval '2 minutes') AS "runtimeRecentlyActive",
            regexp_replace(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '-+', '-', 'g') AS slug
       FROM work_agents
      WHERE active AND ($1::text IS NULL OR id::text ILIKE '%' || $1 || '%'
        OR name ILIKE '%' || $1 || '%' OR owner_wallet ILIKE '%' || $1 || '%'
        OR regexp_replace(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '-+', '-', 'g') = lower($1))
        AND ($2::text IS NULL OR cardinality(categories)=0 OR $2=ANY(categories) OR 'general'=ANY(categories))
      ORDER BY "runtimeRecentlyActive" DESC, "lastRuntimeSeen" DESC NULLS LAST, created_at DESC LIMIT 100`,
    [query.search ?? null, query.category?.toLowerCase() ?? null],
  );
  response.json({ data: result.rows });
});

agentsRouter.get("/:identifier/record", async (request, response) => {
  const identifier = z.string().trim().min(1).max(120).parse(request.params.identifier);
  const agent = await pool.query<{
    id: string; owner_wallet: string; name: string; description: string; categories: string[];
    capabilities: string[]; created_at: Date; slug: string; last_runtime_seen: Date | null;
    runtime_recently_active: boolean;
  }>(
    `SELECT id, owner_wallet, name, description, categories, capabilities, created_at,
            (SELECT max(t.last_used_at) FROM agent_runtime_tokens t WHERE t.agent_id=work_agents.id
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) AS last_runtime_seen,
            EXISTS (SELECT 1 FROM agent_runtime_tokens t WHERE t.agent_id=work_agents.id
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
              AND t.last_used_at > now() - interval '2 minutes') AS runtime_recently_active,
            regexp_replace(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '-+', '-', 'g') AS slug
       FROM work_agents WHERE active AND (
         ($1::boolean AND id = $2::uuid) OR
         regexp_replace(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '-+', '-', 'g') = lower($3)
       )
      ORDER BY CASE WHEN $1::boolean AND id = $2::uuid THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    [/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier) ? identifier : "00000000-0000-4000-8000-000000000000",
      identifier],
  );
  if (!agent.rows[0]) throw new ApiError(404, "agent_not_found", "No active GuildHall agent matches that name or ID.");
  const id = agent.rows[0].id;
  const [stats, paidByAsset, records, ratings] = await Promise.all([
    pool.query<{
      settled_commissions: number; accepted_commissions: number; total_settled_commissions: number;
      flagged_commissions: number; excluded_commissions: number;
      distinct_clients: number; lost_appeals: number; rating_count: number; weighted_rating: string | null;
    }>(
      // Integrity flags remove self-dealing and reciprocal work from reputation and halve other flagged work.
      `SELECT count(*) FILTER (WHERE i.reputation_weight > 0)::int AS settled_commissions,
              count(*) FILTER (WHERE i.reputation_weight > 0 AND wr.outcome IN ('accepted', 'tribunal_provider'))::int AS accepted_commissions,
              count(*)::int AS total_settled_commissions,
              count(*) FILTER (WHERE cardinality(i.flags) > 0)::int AS flagged_commissions,
              count(*) FILTER (WHERE i.reputation_weight = 0)::int AS excluded_commissions,
              count(DISTINCT wr.client_user_id) FILTER (WHERE i.reputation_weight > 0)::int AS distinct_clients,
              (SELECT count(DISTINCT c.id)::int FROM commissions c JOIN tribunal_cases tc ON tc.commission_id=c.id
                WHERE c.provider_agent_id=$1 AND tc.stage='decided' AND tc.appealed_by=c.provider_user_id
                  AND tc.outcome IN ('client', 'split')) AS lost_appeals,
              (SELECT count(*)::int FROM work_record_feedback f JOIN work_records fw ON fw.id=f.work_record_id
                 JOIN work_record_integrity_flags fi ON fi.work_record_id=fw.id
                WHERE fw.provider_agent_id=$1 AND fi.reputation_weight > 0) AS rating_count,
              (SELECT (sum(f.rating::numeric * f.weight_atomic * fi.reputation_weight) / NULLIF(sum(f.weight_atomic * fi.reputation_weight), 0))::text
                 FROM work_record_feedback f JOIN work_records fw ON fw.id=f.work_record_id
                 JOIN work_record_integrity_flags fi ON fi.work_record_id=fw.id WHERE fw.provider_agent_id=$1) AS weighted_rating
         FROM work_records wr JOIN work_record_integrity_flags i ON i.work_record_id=wr.id WHERE wr.provider_agent_id=$1`, [id],
    ),
    pool.query(
      `SELECT asset_mint AS "assetMint", sum(paid_amount_atomic)::text AS "paidAmountAtomic"
         FROM work_records WHERE provider_agent_id=$1 AND paid_amount_atomic > 0
        GROUP BY asset_mint ORDER BY asset_mint`, [id],
    ),
    pool.query(
      `SELECT wr.commission_id AS "commissionId", c.title, c.work_category AS category,
              wr.asset_mint AS "assetMint", wr.amount_atomic::text AS "amountAtomic",
              wr.paid_amount_atomic::text AS "paidAmountAtomic", wr.outcome, wr.finalized_at AS "finalizedAt",
              chain.state AS "chainState", chain.transaction_signature AS "chainSignature",
              integrity.flags AS "integrityFlags", integrity.reputation_weight::float AS "reputationWeight"
         FROM work_records wr JOIN commissions c ON c.id=wr.commission_id
         LEFT JOIN work_record_chain_operations chain ON chain.work_record_id=wr.id
         JOIN work_record_integrity_flags integrity ON integrity.work_record_id=wr.id
        WHERE wr.provider_agent_id=$1 ORDER BY wr.finalized_at DESC, wr.id DESC`, [id],
    ),
    pool.query(
      `SELECT f.id, f.rating, f.comment, f.weight_atomic::text AS "weightAtomic", f.created_at AS "createdAt",
              reviewer.wallet_address AS "reviewerWallet", wr.commission_id AS "commissionId", c.title AS "commissionTitle",
              chain.state AS "registryState", chain.transaction_signature AS "registrySignature"
         FROM work_record_feedback f JOIN work_records wr ON wr.id=f.work_record_id
         JOIN commissions c ON c.id=wr.commission_id
         JOIN wallet_users reviewer ON reviewer.id=f.reviewer_user_id
         LEFT JOIN registry_feedback_operations chain ON chain.feedback_id=f.id
        WHERE wr.provider_agent_id=$1 ORDER BY f.created_at DESC`, [id],
    ),
  ]);
  const totals = stats.rows[0];
  response.json({ data: {
    agent: { id, ownerWallet: agent.rows[0].owner_wallet, name: agent.rows[0].name,
      description: agent.rows[0].description, categories: agent.rows[0].categories,
      capabilities: agent.rows[0].capabilities, createdAt: agent.rows[0].created_at, slug: agent.rows[0].slug,
      lastRuntimeSeen: agent.rows[0].last_runtime_seen,
      runtimeRecentlyActive: agent.rows[0].runtime_recently_active },
    record: { settledCommissions: totals.settled_commissions, acceptedCommissions: totals.accepted_commissions,
      acceptanceRate: totals.settled_commissions === 0 ? 0 : totals.accepted_commissions / totals.settled_commissions,
      distinctClients: totals.distinct_clients,
      totalSettledCommissions: totals.total_settled_commissions, flaggedCommissions: totals.flagged_commissions,
      excludedCommissions: totals.excluded_commissions,
      lostAppeals: totals.lost_appeals, ratingCount: totals.rating_count,
      weightedRating: totals.weighted_rating === null ? null : Number(totals.weighted_rating) },
    workRecords: records.rows,
    ratings: ratings.rows,
    cluster: config.SOLANA_CLUSTER,
    assets: { USDC: config.USDC_MINT ?? null, USDT: config.USDT_MINT ?? null },
    paidByAsset: paidByAsset.rows,
  } });
});

agentsRouter.get("/mine", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT a.id, a.owner_wallet AS "ownerWallet", a.name, a.description, a.categories, a.capabilities,
            a.active, a.created_at AS "createdAt", a.updated_at AS "updatedAt",
            EXISTS (SELECT 1 FROM agent_runtime_tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now())) AS "runtimeConnected",
            (SELECT t.expires_at FROM agent_runtime_tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL
              ORDER BY t.created_at DESC LIMIT 1) AS "runtimeExpiresAt",
            (SELECT max(t.last_used_at) FROM agent_runtime_tokens t WHERE t.agent_id=a.id
              AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) AS "lastRuntimeSeen",
            EXISTS (SELECT 1 FROM agent_runtime_tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now())
              AND t.last_used_at > now() - interval '2 minutes') AS "runtimeRecentlyActive"
       FROM work_agents a WHERE a.owner_user_id=$1 ORDER BY a.created_at DESC`,
    [request.auth!.userId],
  );
  response.json({ data: result.rows });
});

agentsRouter.post("/", requireAuth, async (request, response) => {
  const input = agentInput.extend({ expiresInDays: tokenLifetimeDays }).parse(request.body);
  const token = newAgentRuntimeToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO work_agents (owner_user_id, owner_wallet, name, description, categories, capabilities)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [request.auth!.userId, request.auth!.walletAddress, input.name, input.description, input.categories, input.capabilities],
    );
    const tokenResult = await client.query<{ expires_at: Date }>(
      `INSERT INTO agent_runtime_tokens (agent_id, token_hash, expires_at)
       VALUES ($1,$2,now() + ($3::int * interval '1 day')) RETURNING expires_at`,
      [inserted.rows[0].id, hashAgentRuntimeToken(token), input.expiresInDays],
    );
    await client.query("COMMIT");
    response.status(201).json({
      data: {
        id: inserted.rows[0].id,
        name: input.name,
        description: input.description,
        categories: input.categories,
        capabilities: input.capabilities,
        ownerWallet: request.auth!.walletAddress,
        active: true,
        runtimeExpiresAt: tokenResult.rows[0].expires_at,
        runtimeToken: token,
      },
      tokenWarning: "Copy this token now. It is shown only once and expires on the date shown.",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

agentsRouter.post("/:id/runtime-token", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = z.object({ expiresInDays: tokenLifetimeDays }).parse(request.body ?? {});
  const token = newAgentRuntimeToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query("SELECT 1 FROM work_agents WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, request.auth!.userId]);
    if (!owned.rowCount) throw new ApiError(404, "agent_not_found", "Agent not found for this wallet.");
    await client.query("UPDATE agent_runtime_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=$1", [id]);
    const tokenResult = await client.query<{ expires_at: Date }>(
      `INSERT INTO agent_runtime_tokens (agent_id, token_hash, expires_at)
       VALUES ($1,$2,now() + ($3::int * interval '1 day')) RETURNING expires_at`,
      [id, hashAgentRuntimeToken(token), input.expiresInDays],
    );
    await client.query("COMMIT");
    response.status(201).json({
      data: { agentId: id, runtimeToken: token, expiresAt: tokenResult.rows[0].expires_at },
      tokenWarning: "Copy this token now. It is shown only once.",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

agentsRouter.patch("/:id", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = z.object({ active: z.boolean() }).strict().parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query("SELECT 1 FROM work_agents WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, request.auth!.userId]);
    if (!owned.rowCount) throw new ApiError(404, "agent_not_found", "Agent not found for this wallet.");
    if (!input.active) {
      const activeJobs = await client.query(
        "SELECT 1 FROM commissions WHERE provider_agent_id=$1 AND status IN ('funded','submitted') LIMIT 1", [id],
      );
      if (activeJobs.rowCount) throw new ApiError(409, "agent_has_active_commissions", "Release or finish this agent's active commissions before deactivating it.");
    }
    const result = await client.query(
      `UPDATE work_agents SET active=$3, updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 RETURNING id, owner_wallet AS "ownerWallet", name, description, categories, capabilities, active`,
      [id, request.auth!.userId, input.active],
    );
    await client.query("COMMIT");
    response.json({ data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

export const agentRuntimeRouter = Router();

agentRuntimeRouter.get("/commissions", requireAgentRuntime, async (request, response) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
  const result = await pool.query(
    `SELECT c.*, w.public_key AS escrow_address
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id=c.id
       JOIN work_agents a ON a.id=$1 AND a.active
      WHERE c.status='funded' AND c.provider_user_id IS NULL AND c.accepted_at IS NULL
        AND c.deadline_at > now() AND c.client_user_id <> a.owner_user_id
        AND (cardinality(a.categories)=0 OR c.work_category=ANY(a.categories))
        AND c.work_type IN ('standard','interop','watch')
      ORDER BY c.funded_at ASC NULLS LAST, c.created_at ASC LIMIT $2`,
    [request.agentRuntime!.agentId, query.limit],
  );
  response.json({ data: result.rows.map(publicCommission) });
});

agentRuntimeRouter.get("/watch-commissions", requireAgentRuntime, async (request, response) => {
  const result = await pool.query(
    `SELECT c.*, w.public_key AS escrow_address
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id=c.id
      WHERE c.work_type='watch' AND c.status='funded'
        AND c.provider_agent_id=$1 AND c.provider_user_id=$2
      ORDER BY c.funded_at ASC NULLS LAST LIMIT 50`,
    [request.agentRuntime!.agentId, request.agentRuntime!.ownerUserId],
  );
  response.json({ data: result.rows.map(publicCommission) });
});

agentRuntimeRouter.post("/commissions/:id/claim", requireAgentRuntime, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const selected = await client.query<{
      id: string; owner_user_id: string; owner_wallet: string; client_user_id: string;
      provider_user_id: string | null; provider_wallet: string | null; provider_agent_id: string | null;
      categories: string[]; work_category: string; status: string; deadline_at: Date; work_type: string;
      accepted_at: Date | null;
    }>(
      `SELECT c.id,c.client_user_id,c.provider_user_id,c.provider_wallet,c.provider_agent_id,c.status,c.deadline_at,c.work_type,c.work_category,c.accepted_at,
              a.owner_user_id,a.owner_wallet,a.categories
         FROM commissions c CROSS JOIN work_agents a WHERE c.id=$1 AND a.id=$2 AND a.active FOR UPDATE OF c,a`,
      [id, request.agentRuntime!.agentId],
    );
    const job = selected.rows[0];
    if (!job) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (job.provider_agent_id === request.agentRuntime!.agentId && job.provider_user_id === job.owner_user_id) {
      await client.query("COMMIT");
      response.json({ data: { id, claimed: true, idempotentReplay: true } });
      return;
    }
    if (job.client_user_id === job.owner_user_id) throw new ApiError(409, "self_acceptance", "An agent cannot accept a commission posted by its owner wallet.");
    if (!['standard', 'interop', 'watch'].includes(job.work_type)) throw new ApiError(409, "agent_work_type_unsupported", "This agent endpoint accepts standard, Interop, and Watch Commissions.");
    if (job.categories.length && !job.categories.includes(job.work_category)) throw new ApiError(403, "agent_category_mismatch", "This commission is outside the agent's registered categories.");
    if (job.status !== "funded" || job.provider_user_id || job.accepted_at || job.deadline_at <= new Date()) {
      throw new ApiError(409, "commission_unavailable", "This funded commission is no longer available to claim.");
    }
    if (job.provider_wallet && job.provider_wallet !== job.owner_wallet) throw new ApiError(409, "agent_wallet_mismatch", "This commission is assigned to a different provider wallet.");
    await client.query(
      `UPDATE commissions SET provider_user_id=$2,provider_wallet=$3,provider_agent_id=$4,accepted_at=now(),updated_at=now()
        WHERE id=$1`,
      [id, job.owner_user_id, job.owner_wallet, request.agentRuntime!.agentId],
    );
    await client.query("COMMIT");
    response.json({ data: { id, claimed: true, providerAgentId: request.agentRuntime!.agentId, providerWallet: job.owner_wallet } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

agentRuntimeRouter.post("/commissions/:id/submissions", requireAgentRuntime, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const assigned = await pool.query(
    "SELECT 1 FROM commissions WHERE id=$1 AND provider_agent_id=$2 AND provider_user_id=$3",
    [id, request.agentRuntime!.agentId, request.agentRuntime!.ownerUserId],
  );
  if (!assigned.rowCount) throw new ApiError(403, "agent_commission_forbidden", "This agent is not assigned to the commission.");
  const submission = await submitCommissionWork(id, request.agentRuntime!.ownerUserId, request.body, request.agentRuntime!.agentId);
  response.status(201).json({ data: submission });
});

agentRuntimeRouter.post("/commissions/:id/watch-alerts", requireAgentRuntime, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = watchAlertSchema.parse(request.body);
  const selected = await pool.query<{
    provider_agent_id: string | null; provider_user_id: string | null; status: string;
    funded_at: Date | null; deadline_at: Date; watch_terms: unknown;
  }>(
    `SELECT provider_agent_id, provider_user_id, status, funded_at, deadline_at, watch_terms
       FROM commissions WHERE id = $1 AND work_type = 'watch'`, [id],
  );
  const commission = selected.rows[0];
  if (!commission) throw new ApiError(404, "watch_commission_not_found", "Watch Commission not found.");
  if (commission.provider_agent_id !== request.agentRuntime!.agentId || commission.provider_user_id !== request.agentRuntime!.ownerUserId) {
    throw new ApiError(403, "watch_agent_unassigned", "This agent is not assigned to the Watch Commission.");
  }
  if (!['funded', 'submitted'].includes(commission.status) || !commission.funded_at) {
    throw new ApiError(409, "watch_commission_not_funded", "Watch alerts can only be submitted for a funded commission.");
  }
  const terms = watchTermsSchema.parse(commission.watch_terms);
  if (terms.trigger.type !== input.alertType) throw new ApiError(400, "watch_alert_type_mismatch", "Alert type must match the commission's configured watch condition.");
  const observedAt = new Date(input.observedAt);
  const monitoringEndsAt = new Date(Math.min(
    commission.funded_at.getTime() + terms.monitoringHours * 60 * 60 * 1000,
    commission.deadline_at.getTime(),
  ));
  if (observedAt < commission.funded_at || observedAt > monitoringEndsAt || observedAt > new Date()) {
    throw new ApiError(422, "watch_alert_outside_window", "The alert timestamp must fall within the funded monitoring window and cannot be in the future.");
  }
  const digest = watchAlertDigest(input);
  const prior = await pool.query<{ id: string; payload_digest: string; created_at: Date }>(
    "SELECT id, payload_digest, created_at FROM watch_commission_alerts WHERE commission_id = $1 AND agent_id = $2 AND idempotency_key = $3",
    [id, request.agentRuntime!.agentId, input.idempotencyKey],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].payload_digest !== digest) throw new ApiError(409, "watch_alert_idempotency_conflict", "This alert idempotency key was already used for different alert data.");
    response.json({ data: { id: prior.rows[0].id, payloadDigest: digest, receivedAt: prior.rows[0].created_at }, idempotentReplay: true });
    return;
  }
  const count = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM watch_commission_alerts WHERE commission_id = $1", [id]);
  if (count.rows[0].count >= 500) throw new ApiError(429, "watch_alert_limit", "This commission has reached its 500-alert limit.");
  const inserted = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO watch_commission_alerts
       (commission_id, agent_id, idempotency_key, alert_type, observed_at, observed_value,
        reference_value, evidence_url, notes, payload_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (commission_id, agent_id, idempotency_key) DO NOTHING
     RETURNING id, created_at`,
    [id, request.agentRuntime!.agentId, input.idempotencyKey, input.alertType, observedAt,
      input.observedValue, input.referenceValue, input.evidenceUrl, input.notes, digest],
  );
  if (!inserted.rows[0]) {
    const replay = await pool.query<{ id: string; payload_digest: string; created_at: Date }>(
      "SELECT id, payload_digest, created_at FROM watch_commission_alerts WHERE commission_id = $1 AND agent_id = $2 AND idempotency_key = $3",
      [id, request.agentRuntime!.agentId, input.idempotencyKey],
    );
    if (replay.rows[0]?.payload_digest !== digest) throw new ApiError(409, "watch_alert_idempotency_conflict", "This alert idempotency key was already used for different alert data.");
    response.json({ data: { id: replay.rows[0].id, payloadDigest: digest, receivedAt: replay.rows[0].created_at }, idempotentReplay: true });
    return;
  }
  response.status(201).json({ data: { id: inserted.rows[0].id, payloadDigest: digest, receivedAt: inserted.rows[0].created_at } });
});

agentRuntimeRouter.get("/commissions/:id/watch-alerts", requireAgentRuntime, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const assigned = await pool.query(
    `SELECT 1 FROM commissions
      WHERE id=$1 AND work_type='watch' AND provider_agent_id=$2 AND provider_user_id=$3`,
    [id, request.agentRuntime!.agentId, request.agentRuntime!.ownerUserId],
  );
  if (!assigned.rowCount) throw new ApiError(403, "watch_agent_unassigned", "This agent is not assigned to the Watch Commission.");
  const result = await pool.query(
    `SELECT id, idempotency_key AS "idempotencyKey", alert_type AS "alertType",
            observed_at AS "observedAt", observed_value AS "observedValue",
            reference_value AS "referenceValue", evidence_url AS "evidenceUrl", notes,
            payload_digest AS "payloadDigest", created_at AS "receivedAt"
       FROM watch_commission_alerts WHERE commission_id=$1
      ORDER BY observed_at ASC, created_at ASC`, [id],
  );
  response.json({ data: result.rows });
});

agentRuntimeRouter.post("/commissions/:id/submission-assets", requireAgentRuntime,
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "10mb" }), async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "image_required", "Send a PNG, JPEG, or WebP image as the request body.");
    const asset = await stageCommissionImage({
      commissionId: id,
      providerUserId: request.agentRuntime!.ownerUserId,
      providerAgentId: request.agentRuntime!.agentId,
      bytes: request.body,
      contentType: String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    });
    response.status(201).json({ data: asset });
  });

agentRuntimeRouter.delete("/commissions/:id/submission-assets/:assetId", requireAgentRuntime, async (request, response) => {
  const commissionId = z.string().uuid().parse(request.params.id);
  const assetId = z.string().uuid().parse(request.params.assetId);
  await discardStagedCommissionImage({
    commissionId,
    assetId,
    providerUserId: request.agentRuntime!.ownerUserId,
    providerAgentId: request.agentRuntime!.agentId,
  });
  response.status(204).end();
});

agentRuntimeRouter.post("/commissions/:id/release", requireAgentRuntime, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const result = await pool.query(
    `UPDATE commissions SET provider_user_id=NULL,provider_agent_id=NULL,
            provider_wallet=CASE WHEN provider_wallet_locked THEN provider_wallet ELSE NULL END,
            accepted_at=NULL,updated_at=now()
      WHERE id=$1 AND provider_agent_id=$2 AND provider_user_id=$3 AND status='funded'
      RETURNING id`,
    [id, request.agentRuntime!.agentId, request.agentRuntime!.ownerUserId],
  );
  if (!result.rowCount) throw new ApiError(409, "agent_release_unavailable", "The agent cannot release this commission now.");
  response.json({ data: { id, released: true } });
});
