import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/index.js";

const router = Router();

router.get("/", async (request, response) => {
  const query = z.object({
    category: z.string().trim().min(1).max(80).optional(),
    slaHours: z.coerce.number().int().min(1).max(8760).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(request.query);
  const cached = await pool.query<{ market_data: unknown; refreshed_at: Date }>(
    "SELECT market_data, refreshed_at FROM rate_board_snapshots WHERE id = 1 AND refreshed_at > now() - interval '1 hour'",
  );
  if (cached.rows[0]) {
    const market = cached.rows[0].market_data as Array<{ category: string; slaHours: number | null; assetMint: string }>;
    response.json({ data: market.filter((row) => (query.category === undefined || row.category === query.category)
      && (query.slaHours === undefined || row.slaHours === query.slaHours)).slice(0, query.limit),
    basis: "settled escrow work", generatedAt: cached.rows[0].refreshed_at });
    return;
  }
  const result = await pool.query<{
    category: string;
    sla_hours: number | null;
    asset_mint: string;
    settled_jobs: string;
    median_amount: string;
    median_hourly_rate: string | null;
    average_amount: string;
    average_delivery_hours: string | null;
    acceptance_rate: string;
    appeal_overturn_rate: string | null;
  }>(
    `WITH settled AS (
       SELECT c.id, c.work_category AS category, c.sla_hours, c.asset_mint,
              wr.amount_atomic::numeric / 1000000 AS amount,
              EXTRACT(EPOCH FROM (wr.finalized_at - c.funded_at)) / 3600 AS delivery_hours,
              (wr.outcome IN ('accepted', 'tribunal_provider'))::int AS accepted,
              (tc.id IS NOT NULL AND tc.appealed_by IS NOT NULL)::int AS appealed,
              (tc.id IS NOT NULL AND tc.appealed_by IS NOT NULL AND tc.warden_verdict IS NOT NULL
                AND (CASE WHEN tc.outcome = 'dismissed' THEN 'provider' ELSE tc.outcome END)
                  <> (CASE WHEN tc.warden_verdict = 'dismissed' THEN 'provider' ELSE tc.warden_verdict END))::int AS overturned
       FROM work_records wr
       JOIN commissions c ON c.id = wr.commission_id
       LEFT JOIN tribunal_cases tc ON tc.commission_id = c.id AND tc.stage = 'decided'
       WHERE c.status IN ('complete', 'refunded')
         AND ($1::text IS NULL OR c.work_category = $1)
         AND ($2::smallint IS NULL OR c.sla_hours = $2)
     )
     SELECT category, sla_hours, asset_mint,
            COUNT(*)::text AS settled_jobs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)::text AS median_amount,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY amount / NULLIF(sla_hours, 0))::text AS median_hourly_rate,
            AVG(amount)::text AS average_amount,
            AVG(delivery_hours)::text AS average_delivery_hours,
            (AVG(accepted) * 100)::text AS acceptance_rate,
            (((SUM(overturned) FILTER (WHERE appealed = 1))::numeric * 100)
              / NULLIF(COUNT(*) FILTER (WHERE appealed = 1), 0))::text AS appeal_overturn_rate
     FROM settled GROUP BY category, sla_hours, asset_mint
     ORDER BY COUNT(*) DESC, category, sla_hours NULLS LAST LIMIT $3`,
    [query.category ?? null, query.slaHours ?? null, query.limit],
  );
  response.json({
    data: result.rows.map((row) => ({
      category: row.category,
      slaHours: row.sla_hours,
      assetMint: row.asset_mint,
      settledJobs: Number(row.settled_jobs),
      medianAmount: Number(row.median_amount),
      medianHourlyRate: row.median_hourly_rate === null ? null : Number(row.median_hourly_rate),
      averageAmount: Number(row.average_amount),
      averageDeliveryHours: row.average_delivery_hours === null ? null : Number(row.average_delivery_hours),
      acceptanceRatePercent: Number(row.acceptance_rate),
      appealOverturnRatePercent: row.appeal_overturn_rate === null ? null : Number(row.appeal_overturn_rate),
    })),
    basis: "settled escrow work",
  });
});

router.get("/guilds", async (_request, response) => {
  const cached = await pool.query<{ guild_data: unknown; refreshed_at: Date }>(
    "SELECT guild_data, refreshed_at FROM rate_board_snapshots WHERE id = 1 AND refreshed_at > now() - interval '1 hour'",
  );
  if (cached.rows[0]) {
    response.json({ data: cached.rows[0].guild_data, generatedAt: cached.rows[0].refreshed_at });
    return;
  }
  const result = await pool.query<{
    id: string; name: string; sla_hours: number; settled_jobs: string; median_amount: string | null;
    average_delivery_hours: string | null; acceptance_rate: string | null; total_paid_atomic: string;
  }>(
    `SELECT g.id, g.name, g.sla_hours,
            count(wr.id)::text AS settled_jobs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY wr.amount_atomic::numeric / 1000000)::text AS median_amount,
            AVG(EXTRACT(EPOCH FROM (wr.finalized_at - c.funded_at)) / 3600)::text AS average_delivery_hours,
            (AVG((wr.outcome IN ('accepted', 'tribunal_provider'))::int) * 100)::text AS acceptance_rate,
            COALESCE(sum(wr.paid_amount_atomic), 0)::text AS total_paid_atomic
       FROM guilds g LEFT JOIN guild_commissions gc ON gc.guild_id = g.id
       LEFT JOIN commissions c ON c.id = gc.commission_id AND c.status IN ('complete', 'refunded')
       LEFT JOIN work_records wr ON wr.commission_id = c.id
      GROUP BY g.id ORDER BY count(wr.id) DESC, acceptance_rate DESC NULLS LAST, g.name`,
  );
  response.json({ data: result.rows.map((row, index) => ({
    rank: index + 1,
    guildId: row.id,
    name: row.name,
    slaHours: row.sla_hours,
    settledJobs: Number(row.settled_jobs),
    medianAmount: row.median_amount === null ? null : Number(row.median_amount),
    averageDeliveryHours: row.average_delivery_hours === null ? null : Number(row.average_delivery_hours),
    acceptanceRatePercent: row.acceptance_rate === null ? null : Number(row.acceptance_rate),
    totalPaidAtomic: row.total_paid_atomic,
  })) });
});

export { router as rateBoardRouter };

export async function refreshRateBoardSnapshot() {
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-rate-board-refresh')) AS acquired");
    if (!lock.rows[0]?.acquired) return { refreshed: false, reason: "refresh_in_progress" };
    locked = true;
    const age = await db.query<{ due: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM rate_board_snapshots WHERE id = 1 AND refreshed_at > now() - interval '1 hour') AS due",
    );
    if (!age.rows[0]?.due) return { refreshed: false, reason: "snapshot_current" };
    const market = await db.query<{
      category: string; sla_hours: number | null; asset_mint: string; settled_jobs: string;
      median_amount: string; median_hourly_rate: string | null; average_amount: string;
      average_delivery_hours: string | null; acceptance_rate: string; appeal_overturn_rate: string | null;
    }>(
      `WITH settled AS (
         SELECT c.id, c.work_category AS category, c.sla_hours, c.asset_mint,
                wr.amount_atomic::numeric / 1000000 AS amount,
                EXTRACT(EPOCH FROM (wr.finalized_at - c.funded_at)) / 3600 AS delivery_hours,
                (wr.outcome IN ('accepted', 'tribunal_provider'))::int AS accepted,
                (tc.id IS NOT NULL AND tc.appealed_by IS NOT NULL)::int AS appealed,
                (tc.id IS NOT NULL AND tc.appealed_by IS NOT NULL AND tc.warden_verdict IS NOT NULL
                  AND (CASE WHEN tc.outcome = 'dismissed' THEN 'provider' ELSE tc.outcome END)
                    <> (CASE WHEN tc.warden_verdict = 'dismissed' THEN 'provider' ELSE tc.warden_verdict END))::int AS overturned
           FROM work_records wr JOIN commissions c ON c.id = wr.commission_id
           LEFT JOIN tribunal_cases tc ON tc.commission_id = c.id AND tc.stage = 'decided'
          WHERE c.status IN ('complete', 'refunded')
       )
       SELECT category, sla_hours, asset_mint, COUNT(*)::text AS settled_jobs,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)::text AS median_amount,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY amount / NULLIF(sla_hours, 0))::text AS median_hourly_rate,
              AVG(amount)::text AS average_amount,
              AVG(delivery_hours)::text AS average_delivery_hours,
              (AVG(accepted) * 100)::text AS acceptance_rate,
              (((SUM(overturned) FILTER (WHERE appealed = 1))::numeric * 100)
                / NULLIF(COUNT(*) FILTER (WHERE appealed = 1), 0))::text AS appeal_overturn_rate
         FROM settled GROUP BY category, sla_hours, asset_mint
        ORDER BY COUNT(*) DESC, category, sla_hours NULLS LAST`,
    );
    const guilds = await db.query<{
      id: string; name: string; sla_hours: number; settled_jobs: string; median_amount: string | null;
      average_delivery_hours: string | null; acceptance_rate: string | null; total_paid_atomic: string;
    }>(
      `SELECT g.id, g.name, g.sla_hours, count(wr.id)::text AS settled_jobs,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY wr.amount_atomic::numeric / 1000000)::text AS median_amount,
              AVG(EXTRACT(EPOCH FROM (wr.finalized_at - c.funded_at)) / 3600)::text AS average_delivery_hours,
              (AVG((wr.outcome IN ('accepted', 'tribunal_provider'))::int) * 100)::text AS acceptance_rate,
              COALESCE(sum(wr.paid_amount_atomic), 0)::text AS total_paid_atomic
         FROM guilds g LEFT JOIN guild_commissions gc ON gc.guild_id = g.id
         LEFT JOIN commissions c ON c.id = gc.commission_id AND c.status IN ('complete', 'refunded')
         LEFT JOIN work_records wr ON wr.commission_id = c.id
        GROUP BY g.id ORDER BY count(wr.id) DESC, acceptance_rate DESC NULLS LAST, g.name`,
    );
    const marketData = market.rows.map((row) => ({
      category: row.category, slaHours: row.sla_hours, assetMint: row.asset_mint,
      settledJobs: Number(row.settled_jobs), medianAmount: Number(row.median_amount),
      medianHourlyRate: row.median_hourly_rate === null ? null : Number(row.median_hourly_rate),
      averageAmount: Number(row.average_amount), averageDeliveryHours: row.average_delivery_hours === null ? null : Number(row.average_delivery_hours),
      acceptanceRatePercent: Number(row.acceptance_rate),
      appealOverturnRatePercent: row.appeal_overturn_rate === null ? null : Number(row.appeal_overturn_rate),
    }));
    const guildData = guilds.rows.map((row, index) => ({
      rank: index + 1, guildId: row.id, name: row.name, slaHours: row.sla_hours,
      settledJobs: Number(row.settled_jobs), medianAmount: row.median_amount === null ? null : Number(row.median_amount),
      averageDeliveryHours: row.average_delivery_hours === null ? null : Number(row.average_delivery_hours),
      acceptanceRatePercent: row.acceptance_rate === null ? null : Number(row.acceptance_rate), totalPaidAtomic: row.total_paid_atomic,
    }));
    await db.query(
      `INSERT INTO rate_board_snapshots (id, market_data, guild_data, refreshed_at)
       VALUES (1, $1::jsonb, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET market_data = EXCLUDED.market_data,
         guild_data = EXCLUDED.guild_data, refreshed_at = EXCLUDED.refreshed_at`,
      [JSON.stringify(marketData), JSON.stringify(guildData)],
    );
    return { refreshed: true, marketRows: marketData.length, guildRows: guildData.length };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-rate-board-refresh'))").catch(() => undefined);
    db.release();
  }
}
