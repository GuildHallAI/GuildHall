import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";
import { createBountyForWallet, type BountyTerms } from "./bounty-service.js";

type Mention = { id: string; author_id: string; text: string; entities?: { mentions?: Array<{ id: string }> } };

function maxId(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => Boolean(value))
    .reduce<string | null>((max, current) => !max || BigInt(current) > BigInt(max) ? current : max, null);
}

function isBountyCommand(text: string) {
  const withoutLeadingMention = text.trim().replace(/^(?:@\w+\s+)+/, "");
  return /^bounty\b/i.test(withoutLeadingMention);
}

export function parseXBountyCommand(text: string, bondAtomic = config.X_BOUNTY_ENTRY_BOND_ATOMIC): BountyTerms | null {
  const command = text.trim().replace(/^(?:@\w+\s+)+/, "");
  const match = /^bounty\s+((?:0|[1-9]\d{0,11})(?:\.\d{1,6})?)\s+(USDC|USDT)\s+for\s+([\s\S]+?)\s+by\s+(\d{4}-\d{2}-\d{2})$/i.exec(command);
  if (!match) return null;
  const task = match[3].replace(/\s+/g, " ").trim();
  const title = task.slice(0, 160).trim();
  if (task.length < 20 || title.length < 3) return null;
  const date = match[4];
  const deadlineAt = new Date(`${date}T23:59:59.999Z`);
  if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt.toISOString().slice(0, 10) !== date) return null;
  return {
    title,
    description: task,
    asset: match[2].toUpperCase() as "USDC" | "USDT",
    amount: match[1],
    bondAmount: (Number(bondAtomic) / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    maxEntries: config.X_BOUNTY_MAX_ENTRIES,
    category: "general",
    deadlineAt,
  };
}

async function fetchMentionPage(
  sinceId: string | null,
  paginationToken: string | null,
) {
  if (!config.X_USER_ACCESS_TOKEN || !config.X_BOT_USER_ID) {
    return { disabled: true as const, data: [] as Mention[], nextToken: null as string | null };
  }
  const url = new URL(`https://api.x.com/2/users/${config.X_BOT_USER_ID}/mentions`);
  url.searchParams.set("max_results", "100");
  url.searchParams.set("tweet.fields", "author_id,created_at,entities");
  if (sinceId) url.searchParams.set("since_id", sinceId);
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
  const result = await fetch(url, {
    headers: { authorization: `Bearer ${config.X_USER_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error(`x_mentions_http_${result.status}`);
  const payload = z.object({
    data: z.array(z.object({ id: z.string().regex(/^\d{1,30}$/), author_id: z.string().regex(/^\d{1,30}$/), text: z.string().max(10_000),
      entities: z.object({ mentions: z.array(z.object({ id: z.string().regex(/^\d{1,30}$/) })).optional() }).optional() })).optional(),
    meta: z.object({ next_token: z.string().optional() }).optional(),
  }).parse(await result.json());
  return { disabled: false as const, data: payload.data ?? [], nextToken: payload.meta?.next_token ?? null };
}

async function ingestMentionPage() {
  if (!config.X_USER_ACCESS_TOKEN || !config.X_BOT_USER_ID) return { disabled: true, received: 0 };
  const db = await pool.connect();
  let lock: { locked: boolean } | undefined;
  try {
    lock = (await db.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["guildhall:bounty-mentions"],
    )).rows[0];
  } catch (error) { db.release(); throw error; }
  if (!lock?.locked) { db.release(); return { disabled: false, received: 0, busy: true }; }
  try {
    let sinceId: string | null = null;
    let paginationToken: string | null = null;
    await db.query("BEGIN");
    try {
      let cursor = await db.query<{ last_tweet_id: string | null; poll_since_id: string | null; pagination_token: string | null }>(
        `SELECT last_tweet_id, poll_since_id, pagination_token
           FROM x_bot_cursors WHERE name = 'bounty_mentions' FOR UPDATE`,
      );
      if (!cursor.rows[0]) {
        await db.query("INSERT INTO x_bot_cursors (name) VALUES ('bounty_mentions') ON CONFLICT DO NOTHING");
        cursor = await db.query<{ last_tweet_id: string | null; poll_since_id: string | null; pagination_token: string | null }>(
          `SELECT last_tweet_id, poll_since_id, pagination_token
             FROM x_bot_cursors WHERE name = 'bounty_mentions' FOR UPDATE`,
        );
      }
      const current = cursor.rows[0];
      sinceId = current?.pagination_token ? current.poll_since_id : current?.last_tweet_id ?? null;
      paginationToken = current?.pagination_token ?? null;
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }

    // The session advisory lock stays held during the X request, preventing overlapping
    // cron invocations from advancing the pagination cursor out of order.
    const page = await fetchMentionPage(sinceId, paginationToken);
    const ordered = [...page.data].sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);
    const receivedMax = maxId(ordered.map((tweet) => tweet.id));
    await db.query("BEGIN");
    try {
      for (const tweet of ordered) {
        if (!tweet.entities?.mentions?.some((mention) => mention.id === config.X_BOT_USER_ID)
          || !isBountyCommand(tweet.text)) continue;
        await db.query(
          `INSERT INTO x_bounty_commands (tweet_id, author_x_user_id, tweet_text)
           VALUES ($1, $2, $3) ON CONFLICT (tweet_id) DO NOTHING`,
          [tweet.id, tweet.author_id, tweet.text],
        );
      }
      const cursor = await db.query<{ pending_max_tweet_id: string | null }>(
        `SELECT pending_max_tweet_id FROM x_bot_cursors WHERE name = 'bounty_mentions' FOR UPDATE`,
      );
      const priorMax = cursor.rows[0]?.pending_max_tweet_id ?? null;
      if (page.nextToken) {
        await db.query(
          `UPDATE x_bot_cursors SET poll_since_id = $1, pagination_token = $2,
             pending_max_tweet_id = $3, updated_at = now() WHERE name = 'bounty_mentions'`,
          [sinceId, page.nextToken, maxId([priorMax, receivedMax])],
        );
      } else {
        await db.query(
          `UPDATE x_bot_cursors SET last_tweet_id = COALESCE($1, last_tweet_id),
             poll_since_id = NULL, pagination_token = NULL, pending_max_tweet_id = NULL,
             updated_at = now() WHERE name = 'bounty_mentions'`,
          [maxId([priorMax, receivedMax])],
        );
      }
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    return { disabled: false, received: ordered.length, more: Boolean(page.nextToken), busy: false };
  } finally {
    try { await db.query("SELECT pg_advisory_unlock(hashtext($1))", ["guildhall:bounty-mentions"]); }
    finally { db.release(); }
  }
}

export async function reconcileXBountyCommands(limit: number) {
  const polling = await ingestMentionPage();
  const summary = { ...polling, created: 0, ignored: 0, failed: 0, waitingForXLink: 0, retried: 0 };
  const db = await pool.connect();
  let commands: Array<{ tweet_id: string; author_x_user_id: string; tweet_text: string; user_id: string | null; wallet_address: string | null }> = [];
  try {
    await db.query("BEGIN");
    const result = await db.query<{ tweet_id: string; author_x_user_id: string; tweet_text: string; user_id: string | null; wallet_address: string | null }>(
      `SELECT x.tweet_id, x.author_x_user_id, x.tweet_text, l.user_id, u.wallet_address
         FROM x_bounty_commands x LEFT JOIN x_user_links l ON l.x_user_id = x.author_x_user_id
         LEFT JOIN wallet_users u ON u.id = l.user_id
        WHERE x.state = 'pending' AND x.next_attempt_at <= now()
        ORDER BY x.created_at LIMIT $1 FOR UPDATE OF x SKIP LOCKED`, [limit],
    );
    commands = result.rows;
    for (const command of commands) await db.query(
      "UPDATE x_bounty_commands SET next_attempt_at = now() + interval '5 minutes', updated_at = now() WHERE tweet_id = $1 AND state = 'pending'",
      [command.tweet_id],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }

  for (const command of commands) {
    if (!command.user_id || !command.wallet_address) {
      await pool.query(
        "UPDATE x_bounty_commands SET failure_code = 'x_account_not_linked', updated_at = now() WHERE tweet_id = $1 AND state = 'pending'",
        [command.tweet_id],
      );
      summary.waitingForXLink += 1;
      continue;
    }
    const terms = parseXBountyCommand(command.tweet_text);
    if (!terms) {
      await pool.query(
        `UPDATE x_bounty_commands SET state = 'failed', failure_code = 'invalid_bounty_command',
           processed_at = now(), updated_at = now() WHERE tweet_id = $1 AND state = 'pending'`,
        [command.tweet_id],
      );
      summary.failed += 1;
      continue;
    }
    try {
      const created = await createBountyForWallet(command.user_id, command.wallet_address, terms, `x:${command.tweet_id}`, command.tweet_id);
      await pool.query(
        `UPDATE x_bounty_commands SET state = 'created', commission_id = $2, failure_code = NULL,
           processed_at = now(), updated_at = now() WHERE tweet_id = $1 AND state = 'pending'`,
        [command.tweet_id, created.commissionId],
      );
      summary.created += 1;
      if (created.idempotentReplay) summary.retried += 1;
    } catch (error) {
      const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500
        && error.code !== "bounty_evaluator_unavailable";
      await pool.query(
        `UPDATE x_bounty_commands SET state = $2, failure_code = $3,
           next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + interval '5 minutes' ELSE next_attempt_at END,
           processed_at = CASE WHEN $2 = 'failed' THEN now() ELSE processed_at END,
           updated_at = now() WHERE tweet_id = $1 AND state = 'pending'`,
        [command.tweet_id, permanent ? "failed" : "pending",
          error instanceof ApiError ? error.code : "bounty_creation_failed"],
      );
      if (permanent) summary.failed += 1;
      else summary.waitingForXLink += 1;
    }
  }
  return summary;
}
