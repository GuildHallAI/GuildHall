import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { hashAgentRuntimeToken, newAgentRuntimeToken, requireAgentRuntime } from "../agent-auth.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { publicCommission } from "../commission-service.js";
import { submitCommissionWork } from "../commission-work.js";

export const agentsRouter = Router();

const agentInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(1).max(4000),
  categories: z.array(z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i)).max(30).default([]),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
});
const tokenLifetimeDays = z.coerce.number().int().min(1).max(365).default(90);

agentsRouter.get("/", async (_request, response) => {
  const result = await pool.query(
    `SELECT id, owner_wallet AS "ownerWallet", name, description, categories, capabilities,
            created_at AS "createdAt"
       FROM work_agents WHERE active ORDER BY created_at DESC LIMIT 100`,
  );
  response.json({ data: result.rows });
});

agentsRouter.get("/mine", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT a.id, a.owner_wallet AS "ownerWallet", a.name, a.description, a.categories, a.capabilities,
            a.active, a.created_at AS "createdAt", a.updated_at AS "updatedAt",
            EXISTS (SELECT 1 FROM agent_runtime_tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now())) AS "runtimeConnected",
            (SELECT t.expires_at FROM agent_runtime_tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL
              ORDER BY t.created_at DESC LIMIT 1) AS "runtimeExpiresAt"
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
        AND c.work_type IN ('standard','interop')
      ORDER BY c.funded_at ASC NULLS LAST, c.created_at ASC LIMIT $2`,
    [request.agentRuntime!.agentId, query.limit],
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
    if (job.work_type !== "standard" && job.work_type !== "interop") throw new ApiError(409, "agent_work_type_unsupported", "This agent endpoint accepts standard commissions only.");
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
