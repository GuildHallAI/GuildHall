import { config } from "./config.js";
import { pool } from "./db/index.js";
import { evaluatorHasCapacity } from "./ghall.js";

async function reassignStaleBountyEvaluator(commissionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bounty-evaluator:${commissionId}`]);
    const bounty = await client.query<{
      evaluator_user_id: string; amount_atomic: string; client_user_id: string;
      status: string; deadline_at: Date | null; evaluated_at: Date | null; evaluator_assigned_at: Date;
    }>(
      `SELECT b.evaluator_user_id, b.evaluated_at, b.evaluator_assigned_at,
              c.amount_atomic, c.client_user_id, c.status, c.deadline_at
         FROM bounties b JOIN commissions c ON c.id = b.commission_id
        WHERE b.commission_id = $1 FOR UPDATE OF b, c`, [commissionId],
    );
    const row = bounty.rows[0];
    if (!row || row.evaluated_at || row.status !== "funded" || !row.deadline_at
      || row.deadline_at.getTime() + 24 * 60 * 60 * 1000 > Date.now()) {
      await client.query("COMMIT");
      return false;
    }
    const candidates = await client.query<{ user_id: string; wallet_address: string; stake_atomic: string }>(
      `SELECT e.user_id, u.wallet_address, e.stake_atomic::text FROM evaluator_profiles e
         JOIN wallet_users u ON u.id = e.user_id
        WHERE e.active = true AND e.stake_atomic * $1::numeric >= $2::numeric * 5 * 10000 AND e.stake_mint = $3
          AND e.user_id <> $4 AND e.user_id <> $5
          AND (SELECT count(*) FROM tribunal_assignments a WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
          AND (SELECT count(*) FROM bounty_evaluator_assignments a WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
          AND NOT EXISTS (SELECT 1 FROM bounty_evaluator_assignments a WHERE a.commission_id = $6 AND a.user_id = e.user_id)
          AND NOT EXISTS (SELECT 1 FROM bounty_entries be WHERE be.commission_id = $6 AND be.user_id = e.user_id)
        ORDER BY CASE WHEN $7::numeric > 0 AND COALESCE((SELECT gs.stake_atomic FROM ghall_stake_accounts gs WHERE gs.user_id = e.user_id), 0) >= $7::numeric THEN 0 ELSE 1 END,
                 random() LIMIT 50 FOR UPDATE OF e SKIP LOCKED`,
      [config.GHALL_EVALUATOR_MAX_CAPACITY_BPS, row.amount_atomic, config.USDC_MINT, row.client_user_id, row.evaluator_user_id,
        commissionId, config.GHALL_BOUNTY_PRIORITY_THRESHOLD_ATOMIC.toString()],
    );
    let next: { user_id: string } | undefined;
    for (const candidate of candidates.rows) {
      if (await evaluatorHasCapacity(candidate.wallet_address, candidate.stake_atomic, row.amount_atomic)) {
        next = candidate;
        break;
      }
    }
    if (!next) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "UPDATE bounty_evaluator_assignments SET released_at = now() WHERE commission_id = $1 AND user_id = $2 AND released_at IS NULL",
      [commissionId, row.evaluator_user_id],
    );
    await client.query("INSERT INTO bounty_evaluator_assignments (commission_id, user_id) VALUES ($1, $2)", [commissionId, next.user_id]);
    await client.query(
      "UPDATE bounties SET evaluator_user_id = $2, evaluator_assigned_at = now() WHERE commission_id = $1",
      [commissionId, next.user_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function reassignStaleBountyEvaluators(limit = 25) {
  const rows = await pool.query<{ commission_id: string }>(
    `SELECT b.commission_id FROM bounties b JOIN commissions c ON c.id = b.commission_id
      WHERE b.evaluated_at IS NULL AND c.status = 'funded'
        AND c.deadline_at < now() - interval '24 hours'
        AND b.evaluator_assigned_at < now() - interval '24 hours'
      ORDER BY c.deadline_at LIMIT $1`, [limit],
  );
  let reassigned = 0;
  const errors: { commissionId: string; code: string }[] = [];
  for (const row of rows.rows) {
    try { if (await reassignStaleBountyEvaluator(row.commission_id)) reassigned += 1; }
    catch { errors.push({ commissionId: row.commission_id, code: "bounty_reassignment_error" }); }
  }
  return { examined: rows.rows.length, reassigned, errors };
}
