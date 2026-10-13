import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool } from "./db/index.js";

export async function enqueueBountyXPost(
  db: PoolClient,
  commissionId: string,
  kind: "announcement" | "receipt",
  replyToTweetId?: string,
) {
  const actionUrl = `${config.GUILDHALL_ACTIONS_BASE_URL.replace(/\/$/, "")}/api/actions/bounties/${commissionId}`;
  const shareUrl = kind === "announcement"
    ? `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`
    : `${config.GUILDHALL_ACTIONS_BASE_URL.replace(/\/$/, "")}/bounties/${commissionId}`;
  await db.query(
    `INSERT INTO bounty_x_posts (commission_id, kind, action_url, blink_url, reply_to_tweet_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (commission_id, kind) DO NOTHING`,
    [commissionId, kind, actionUrl, shareUrl, replyToTweetId ?? null],
  );
}

function formatUsdc(amountAtomic: string) {
  const amount = BigInt(amountAtomic);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function reconcileBountyXPosts(limit: number) {
  const summary = { disabled: !config.X_USER_ACCESS_TOKEN, published: 0, failed: 0, outcomeUnknown: 0, pending: 0 };
  const stale = await pool.query(
    `UPDATE bounty_x_posts SET state = 'outcome_unknown', failure_code = 'post_interrupted', updated_at = now()
      WHERE state = 'prepared' AND attempted_at < now() - interval '2 minutes' RETURNING commission_id`,
  );
  summary.outcomeUnknown += stale.rowCount ?? 0;
  await pool.query(
    `INSERT INTO bounty_x_posts (commission_id, kind, action_url, blink_url)
     SELECT c.id, 'receipt',
            $1 || '/api/actions/bounties/' || c.id::text,
            $1 || '/bounties/' || c.id::text
       FROM commissions c JOIN bounties b ON b.commission_id = c.id
      WHERE c.status IN ('complete', 'refunded')
     ON CONFLICT (commission_id, kind) DO NOTHING`,
    [config.GUILDHALL_ACTIONS_BASE_URL.replace(/\/$/, "")],
  );
  if (!config.X_USER_ACCESS_TOKEN) {
    const waiting = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM bounty_x_posts WHERE state = 'pending'");
    summary.pending = Number(waiting.rows[0]?.count ?? 0);
    return summary;
  }

  const db = await pool.connect();
  let posts: Array<{ commission_id: string; kind: string; action_url: string; blink_url: string; reply_to_tweet_id: string | null; title: string; amount_atomic: string; asset: string; deadline_at: Date; status: string }> = [];
  try {
    await db.query("BEGIN");
    const picked = await db.query<{ commission_id: string; kind: string; action_url: string; blink_url: string; reply_to_tweet_id: string | null; title: string; amount_atomic: string; asset: string; deadline_at: Date; status: string }>(
      `SELECT p.commission_id, p.kind, p.action_url, p.blink_url, p.reply_to_tweet_id, c.title, c.amount_atomic::text, c.status,
              CASE WHEN c.asset_mint = $2 THEN 'USDC' WHEN c.asset_mint = $3 THEN 'USDT' ELSE 'stablecoin' END AS asset,
              c.deadline_at
         FROM bounty_x_posts p JOIN commissions c ON c.id = p.commission_id
        WHERE p.state = 'pending' AND p.not_before_at <= now()
        ORDER BY p.not_before_at, p.created_at LIMIT $1 FOR UPDATE OF p SKIP LOCKED`,
      [limit, config.USDC_MINT, config.USDT_MINT],
    );
    posts = picked.rows;
    for (const post of posts) await db.query(
      "UPDATE bounty_x_posts SET state = 'prepared', attempted_at = now(), updated_at = now() WHERE commission_id = $1 AND kind = $2 AND state = 'pending'",
      [post.commission_id, post.kind],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }

  for (const post of posts) {
    const title = post.title.replace(/[\r\n\t]+/g, " ").replace(/@/g, "＠").slice(0, 90);
    const due = post.deadline_at.toISOString().slice(0, 10);
    const text = post.kind === "announcement"
      ? `Fund this GuildHall bounty: “${title}” — ${formatUsdc(post.amount_atomic)} ${post.asset}, due ${due} ${post.blink_url}`
      : `GuildHall bounty resolved: “${title}” — ${post.status === "complete" ? "settled" : "refunded"}. Receipt: ${post.blink_url}`;
    try {
      const result = await fetch("https://api.x.com/2/tweets", {
        method: "POST", headers: { authorization: `Bearer ${config.X_USER_ACCESS_TOKEN}`,
        "content-type": "application/json" }, body: JSON.stringify({
          text,
          ...(post.kind === "announcement" && post.reply_to_tweet_id
            ? { reply: { in_reply_to_tweet_id: post.reply_to_tweet_id } }
            : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 429) {
          const retryAfter = result.headers.get("retry-after");
          const retrySeconds = retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : 60;
          const delaySeconds = Math.min(3600, Math.max(1, Number.isFinite(retrySeconds) ? retrySeconds : 60));
          await pool.query(
            `UPDATE bounty_x_posts SET state = 'pending', failure_code = 'x_api_rate_limited',
               not_before_at = now() + ($3::int * interval '1 second'), updated_at = now()
              WHERE commission_id = $1 AND kind = $2 AND state = 'prepared'`,
            [post.commission_id, post.kind, delaySeconds],
          );
          summary.pending += 1;
          continue;
        }
        const finalState = result.status >= 400 && result.status < 500 && result.status !== 429 ? "failed" : "outcome_unknown";
        const code = finalState === "failed" ? `x_api_rejected_${result.status}` : `x_api_status_${result.status}`;
        await pool.query("UPDATE bounty_x_posts SET state = $3, failure_code = $4, updated_at = now() WHERE commission_id = $1 AND kind = $2 AND state = 'prepared'",
          [post.commission_id, post.kind, finalState, code]);
        if (finalState === "failed") summary.failed += 1;
        else summary.outcomeUnknown += 1;
        continue;
      }
      const payload = await result.json() as { data?: { id?: string } };
      if (!payload.data?.id || !/^\d{1,30}$/.test(payload.data.id)) throw new Error("x_api_response_missing_post_id");
      await pool.query(
        `UPDATE bounty_x_posts SET state = 'published', tweet_id = $3, tweet_url = $4,
           published_at = now(), failure_code = NULL, updated_at = now()
          WHERE commission_id = $1 AND kind = $2 AND state = 'prepared'`,
        [post.commission_id, post.kind, payload.data.id, `https://x.com/i/web/status/${payload.data.id}`],
      );
      summary.published += 1;
    } catch {
      await pool.query(`UPDATE bounty_x_posts SET state = 'outcome_unknown',
        failure_code = 'x_api_outcome_unknown', updated_at = now()
        WHERE commission_id = $1 AND kind = $2 AND state = 'prepared'`, [post.commission_id, post.kind]);
      summary.outcomeUnknown += 1;
    }
  }
  return summary;
}
