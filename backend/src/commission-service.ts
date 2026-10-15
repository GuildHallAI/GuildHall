import { createHash } from "node:crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { createCommissionEscrowWallet } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import { assertSafeTaskText, taskSafetyAttestation } from "./task-policy.js";

const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, "Use a positive decimal amount with at most 6 decimal places.");
export const commissionCreateInputSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(20_000),
  asset: z.enum(["USDC", "USDT"]),
  amount: amountInput,
  category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i).default("general"),
  slaHours: z.number().int().min(1).max(8760).optional(),
  providerWallet: z.string().min(32).max(44).optional(),
  requiresTribunal: z.boolean().default(false),
  deadlineAt: z.coerce.date().optional(),
  safetyAttestation: taskSafetyAttestation,
});

type CommissionRow = {
  id: string;
  client_wallet: string;
  provider_wallet: string | null;
  requires_tribunal?: boolean;
  provider_agent_id?: string | null;
  provider_agent_name?: string | null;
  title: string;
  description: string;
  asset_mint: string;
  amount_atomic: string;
  status: string;
  work_type?: string;
  work_category?: string;
  sla_hours?: number | null;
  deadline_at: Date;
  accepted_at: Date | null;
  funding_signature: string | null;
  funded_at: Date | null;
  created_at: Date;
  updated_at: Date;
  escrow_address?: string;
};

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

export function publicCommission(row: CommissionRow) {
  return {
    id: row.id,
    clientWallet: row.client_wallet,
    providerWallet: row.provider_wallet,
    requiresTribunal: row.requires_tribunal ?? true,
    providerAgentId: row.provider_agent_id ?? null,
    providerAgentName: row.provider_agent_name ?? null,
    title: row.title,
    description: row.description,
    assetMint: row.asset_mint,
    amountAtomic: row.amount_atomic,
    status: row.status,
    workType: row.work_type ?? "standard",
    category: row.work_category ?? "general",
    slaHours: row.sla_hours ?? null,
    deadlineAt: row.deadline_at,
    acceptedAt: row.accepted_at,
    fundingSignature: row.funding_signature,
    fundedAt: row.funded_at,
    escrowAddress: row.escrow_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assetMint(asset: "USDC" | "USDT") {
  const mint = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!mint) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try { return new PublicKey(mint).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid Solana mint address.`); }
}

function canonicalWallet(value: string) {
  try { return new PublicKey(value).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "Provider wallet must be a valid Solana address."); }
}

function toAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return atomic.toString();
}

export async function createCommissionForWallet(
  user: { userId: string; walletAddress: string },
  idempotencyKey: string | undefined,
  value: unknown,
) {
  const input = commissionCreateInputSchema.parse(value);
  assertSafeTaskText(input.title, input.description);
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now() + 60_000) {
    throw new ApiError(400, "invalid_deadline", "The deadline must be at least one minute in the future.");
  }
  const providerWallet = input.providerWallet ? canonicalWallet(input.providerWallet) : null;
  const mint = assetMint(input.asset);
  const amountAtomic = toAtomic(input.amount);
  const requestHash = createHash("sha256").update(JSON.stringify({
    title: input.title,
    description: input.description,
    asset: input.asset,
    mint,
    amountAtomic,
    category: input.category,
    slaHours: input.slaHours ?? null,
    providerWallet,
    requiresTribunal: input.requiresTribunal,
    deadlineAt: input.deadlineAt?.toISOString() ?? null,
  })).digest("hex");
  const deadlineAt = input.deadlineAt ?? new Date(Date.now() + (input.slaHours ?? 168) * 60 * 60 * 1000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [user.userId, idempotencyKey]);
    const existing = await client.query<CommissionRow & { request_hash: string | null }>(
      `SELECT c.*, w.public_key AS escrow_address
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.client_user_id = $1 AND c.idempotency_key = $2`, [user.userId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different commission details.");
      }
      await client.query("COMMIT");
      return { data: publicCommission(existing.rows[0]), idempotentReplay: true };
    }
    const inserted = await client.query<CommissionRow>(
      `INSERT INTO commissions
         (client_user_id, client_wallet, provider_wallet, title, description, asset_mint,
          amount_atomic, status, deadline_at, idempotency_key, request_hash, work_category, sla_hours, requires_tribunal, provider_wallet_locked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [user.userId, user.walletAddress, providerWallet, input.title, input.description,
        mint, amountAtomic, deadlineAt, idempotencyKey, requestHash, input.category, input.slaHours ?? null,
        input.requiresTribunal, Boolean(providerWallet)],
    );
    const escrow = await createCommissionEscrowWallet(client, inserted.rows[0].id);
    await client.query("COMMIT");
    return { data: publicCommission({ ...inserted.rows[0], escrow_address: escrow.publicKey }), idempotentReplay: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimCommissionForWallet(
  commissionId: string,
  user: { userId: string; walletAddress: string },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [commissionId]);
    const selected = await client.query<CommissionRow & {
      client_user_id: string;
      provider_user_id: string | null;
    }>("SELECT * FROM commissions WHERE id = $1 FOR UPDATE", [commissionId]);
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.work_type === "bounty") {
      throw new ApiError(409, "bounty_uses_ranked_entry", "Bounty winners are selected through the assigned evaluator.");
    }
    if (commission.client_user_id === user.userId) {
      throw new ApiError(409, "self_acceptance", "A client cannot accept their own commission.");
    }
    if (commission.deadline_at <= new Date()) {
      throw new ApiError(409, "commission_expired", "The commission deadline has passed and it can no longer be accepted.");
    }
    if (!["open", "funded"].includes(commission.status)) {
      throw new ApiError(409, "commission_unavailable", "This commission cannot be accepted in its current state.");
    }
    if (commission.provider_user_id && commission.provider_user_id !== user.userId) {
      throw new ApiError(409, "commission_claimed", "This commission has already been accepted by another provider.");
    }
    if (commission.provider_wallet && commission.provider_wallet !== user.walletAddress) {
      throw new ApiError(409, "provider_wallet_mismatch", "This commission is assigned to a different provider wallet.");
    }
    const updated = await client.query<CommissionRow>(
      `UPDATE commissions SET provider_user_id = $2, provider_wallet = $3,
         accepted_at = COALESCE(accepted_at, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [commissionId, user.userId, user.walletAddress],
    );
    await client.query("COMMIT");
    return publicCommission(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getCommissionFundingInstructions(commissionId: string) {
  const result = await pool.query<CommissionRow>(
    `SELECT c.*, w.public_key AS escrow_address
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
      WHERE c.id = $1`, [commissionId],
  );
  const commission = result.rows[0];
  if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
  const surety = await pool.query<{ state: string }>("SELECT state FROM surety_policies WHERE commission_id = $1", [commissionId]);
  if (surety.rows[0]?.state === "awaiting_premium") throw new ApiError(409, "surety_premium_required", "Confirm or cancel this commission's Surety premium before funding it.");
  if (!commission.escrow_address) throw new ApiError(409, "escrow_unavailable", "The commission escrow account is not ready.");
  if (commission.deadline_at <= new Date()) throw new ApiError(409, "commission_expired", "The commission deadline has passed and the commission can no longer be funded.");
  if (commission.funding_signature) throw new ApiError(409, "already_funded", "This commission already has a confirmed funding transaction.");
  const escrow = new PublicKey(commission.escrow_address);
  const mint = new PublicKey(commission.asset_mint);
  const clientWallet = new PublicKey(commission.client_wallet);
  const sourceTokenAccount = getAssociatedTokenAddressSync(mint, clientWallet);
  const tokenAccount = getAssociatedTokenAddressSync(mint, escrow);
  const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: clientWallet, recentBlockhash: latestBlockhash.blockhash }).add(
    createAssociatedTokenAccountIdempotentInstruction(clientWallet, sourceTokenAccount, clientWallet, mint),
    createAssociatedTokenAccountIdempotentInstruction(clientWallet, tokenAccount, escrow, mint),
    createTransferCheckedInstruction(sourceTokenAccount, mint, tokenAccount, clientWallet,
      BigInt(commission.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
  );
  return { commissionId, cluster: config.SOLANA_CLUSTER, assetMint: commission.asset_mint,
    sourceTokenAccount: sourceTokenAccount.toBase58(), tokenAccount: tokenAccount.toBase58(),
    escrowOwner: escrow.toBase58(), amountAtomic: commission.amount_atomic, decimals: 6,
    clientWallet: commission.client_wallet,
    unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight };
}
