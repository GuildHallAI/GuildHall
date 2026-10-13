import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { createHandForWallet, publicHand } from "../hand-service.js";

const router = Router();

router.get("/", async (request, response) => {
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().datetime().optional(),
  }).parse(request.query);
  const result = await pool.query(
    `SELECT c.*, w.public_key AS escrow_address
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
      WHERE c.work_type = 'hand' AND c.status IN ('open', 'funded') AND c.provider_user_id IS NULL
        AND c.deadline_at > now()
        AND ($1::timestamptz IS NULL OR c.created_at < $1)
      ORDER BY c.created_at DESC LIMIT $2`,
    [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows.map((row) => publicHand(row as Parameters<typeof publicHand>[0])) });
});

router.post("/", requireAuth, async (request, response) => {
  const result = await createHandForWallet(request.auth!, request.header("idempotency-key"), request.body);
  response.status(result.idempotentReplay ? 200 : 201).json(result);
});

router.get("/:id", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const result = await pool.query(
    `SELECT c.*, w.public_key AS escrow_address FROM commissions c
      LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
     WHERE c.id = $1 AND c.work_type = 'hand'`, [id],
  );
  if (!result.rows[0]) throw new ApiError(404, "hand_not_found", "Hands task not found.");
  response.json({ data: publicHand(result.rows[0] as Parameters<typeof publicHand>[0]) });
});

export { router as handsRouter };
