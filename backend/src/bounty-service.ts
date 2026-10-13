import { createHash } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { evaluatorHasCapacity } from "./ghall.js";
import { createCommissionEscrowWallet } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import { enqueueBountyXPost } from "./bounty-x.js";
import { assertSafeTaskText, taskSafetyAttestation } from "./task-policy.js";

const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
export const bountyCreateInputSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(10_000),
  asset: z.enum(["USDC", "USDT"]),
  amount: amountInput,
  bondAmount: amountInput,
  maxEntries: z.number().int().min(1).max(100).default(20),
  category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  slaHours: z.number().int().min(1).max(8760).optional(),
  deadlineAt: z.coerce.date(),
  safetyAttestation: taskSafetyAttestation,
});

export type BountyTerms = {
  title: string;
  description: string;
  asset: "USDC" | "USDT";
  amount: string;
  bondAmount: string;
  maxEntries: number;
  category: string;
  slaHours?: number;
  deadlineAt: Date;
};

function toAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (value <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return value.toString();
}

function mintFor(asset: "USDC" | "USDT") {
  const configured = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!configured) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try { return new PublicKey(configured).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid mint configuration.`); }
}

export async function createBountyForWallet(
  userId: string,
  walletAddress: string,
  terms: BountyTerms,
  idempotencyKey: string,
  replyToTweetId?: string,
) {
  assertSafeTaskText(terms.title, terms.description);
  if (terms.deadlineAt.getTime() <= Date.now() + 60_000) {
    throw new ApiError(400, "invalid_deadline", "The deadline must be at least one minute in the future.");
  }
  const potAtomic = toAtomic(terms.amount);
  const bondAtomic = toAtomic(terms.bondAmount);
  if (BigInt(bondAtomic) * 10n > BigInt(potAtomic)) {
    throw new ApiError(400, "bounty_bond_too_large", "The entrant bond cannot exceed ten percent of the bounty pot.");
  }
  const mint = mintFor(terms.asset);
  const scopedKey = `bounty:${idempotencyKey}`;
  const requestHash = createHash("sha256").update(JSON.stringify({
    ...terms, potAtomic, bondAtomic, mint, userId,
  })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, scopedKey]);
    const prior = await client.query<{ id: string; request_hash: string | null }>(
      "SELECT id, request_hash FROM commissions WHERE client_user_id = $1 AND idempotency_key = $2",
      [userId, scopedKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different bounty terms.");
      }
      await client.query("COMMIT");
      return { commissionId: prior.rows[0].id, idempotentReplay: true };
    }

    const evaluators = await client.query<{ user_id: string; wallet_address: string; stake_atomic: string }>(
      `SELECT e.user_id, u.wallet_address, e.stake_atomic::text FROM evaluator_profiles e
         JOIN wallet_users u ON u.id = e.user_id
        WHERE e.active = true AND e.stake_atomic * $1::numeric >= $2::numeric * 5 * 10000
          AND e.stake_mint = $3 AND e.user_id <> $4
          AND (SELECT count(*) FROM tribunal_assignments a WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
          AND (SELECT count(*) FROM bounty_evaluator_assignments a WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
        ORDER BY CASE WHEN $5::numeric > 0 AND COALESCE((SELECT gs.stake_atomic FROM ghall_stake_accounts gs WHERE gs.user_id = e.user_id), 0) >= $5::numeric THEN 0 ELSE 1 END,
                 random() LIMIT 50 FOR UPDATE OF e SKIP LOCKED`,
      [config.GHALL_EVALUATOR_MAX_CAPACITY_BPS, potAtomic, config.USDC_MINT, userId, config.GHALL_BOUNTY_PRIORITY_THRESHOLD_ATOMIC.toString()],
    );
    let evaluator: { user_id: string } | undefined;
    for (const candidate of evaluators.rows) {
      if (await evaluatorHasCapacity(candidate.wallet_address, candidate.stake_atomic, potAtomic)) {
        evaluator = candidate;
        break;
      }
    }
    if (!evaluator) {
      throw new ApiError(409, "bounty_evaluator_unavailable", "No eligible staked evaluator is currently available for this bounty.");
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO commissions
         (client_user_id, client_wallet, title, description, asset_mint, amount_atomic, status,
          deadline_at, idempotency_key, request_hash, work_type, work_category, sla_hours)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, 'bounty', $10, $11) RETURNING id`,
      [userId, walletAddress, terms.title, terms.description, mint, potAtomic, terms.deadlineAt,
        scopedKey, requestHash, terms.category, terms.slaHours ?? null],
    );
    const commissionId = inserted.rows[0].id;
    await createCommissionEscrowWallet(client, commissionId);
    await client.query(
      `INSERT INTO bounties (commission_id, bond_atomic, max_entries, evaluator_user_id)
       VALUES ($1, $2, $3, $4)`,
      [commissionId, bondAtomic, terms.maxEntries, evaluator.user_id],
    );
    await client.query(
      "INSERT INTO bounty_evaluator_assignments (commission_id, user_id) VALUES ($1, $2)",
      [commissionId, evaluator.user_id],
    );
    await enqueueBountyXPost(client, commissionId, "announcement", replyToTweetId);
    await client.query("COMMIT");
    return { commissionId, idempotentReplay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
