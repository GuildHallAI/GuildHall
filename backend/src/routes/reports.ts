import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";

export const reportsRouter = Router();
const uuidSchema = z.string().uuid();
const reportInput = z.object({
  commissionId: uuidSchema,
  reason: z.enum(["illegal_or_unsafe", "minors", "harassment", "surveillance", "personal_data", "other"]),
  details: z.string().trim().min(1).max(5000),
});

reportsRouter.post("/tasks", requireAuth, async (request, response) => {
  const input = reportInput.parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [request.auth!.userId, idempotencyKey]);
    const existing = await client.query<{ id: string; request_hash: string; state: string }>(
      "SELECT id, request_hash, state FROM task_reports WHERE reporter_user_id = $1 AND idempotency_key = $2",
      [request.auth!.userId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for another report.");
      }
      await client.query("COMMIT");
      response.json({ data: { id: existing.rows[0].id, state: existing.rows[0].state }, idempotentReplay: true });
      return;
    }
    const target = await client.query("SELECT id FROM commissions WHERE id = $1", [input.commissionId]);
    if (!target.rowCount) throw new ApiError(404, "task_not_found", "The reported task was not found.");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO task_reports
         (commission_id, reporter_user_id, reporter_wallet, reason, details, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (commission_id, reporter_user_id) WHERE state = 'open' DO NOTHING
       RETURNING id`,
      [input.commissionId, request.auth!.userId, request.auth!.walletAddress,
        input.reason, input.details, idempotencyKey, requestHash],
    );
    if (!inserted.rowCount) {
      const existingOpen = await client.query<{ id: string }>(
        "SELECT id FROM task_reports WHERE commission_id = $1 AND reporter_user_id = $2 AND state = 'open'",
        [input.commissionId, request.auth!.userId],
      );
      await client.query("COMMIT");
      response.json({ data: { id: existingOpen.rows[0]?.id, state: "open" }, duplicateOpenReport: true });
      return;
    }
    await client.query("COMMIT");
    response.status(201).json({ data: { id: inserted.rows[0].id, state: "open" } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

reportsRouter.get("/me", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT r.id, r.commission_id, r.reason, r.details, r.state, r.resolution,
            r.resolution_note, r.created_at, r.resolved_at
       FROM task_reports r WHERE r.reporter_user_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [request.auth!.userId],
  );
  response.json({ data: result.rows });
});
