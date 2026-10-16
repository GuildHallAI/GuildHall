import { Router } from "express";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import {
  ensureSuretyPool, loadSuretyPool, suretyPoolBalance, suretyPoolOverview,
  suretyPremiumRate, suretyReservedAtomic, suretyUsdcMint,
} from "../surety-pool.js";

export const suretyRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const decimalAmount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const uuid = z.string().uuid();
const virtualPoolAssets = 1_000_000n;
const virtualPoolShares = 1_000_000n;

function quotePoolShares(amount: bigint, accounted: bigint, shares: bigint) {
  return amount * (shares + virtualPoolShares) / (accounted + virtualPoolAssets);
}

function toAtomic(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return amount;
}

function treasuryWallet() {
  if (!config.TREASURY_WALLET) throw new ApiError(503, "surety_treasury_unavailable", "TREASURY_WALLET is required for Surety premium fees.");
  try { return new PublicKey(config.TREASURY_WALLET).toBase58(); }
  catch { throw new ApiError(503, "surety_treasury_misconfigured", "TREASURY_WALLET is not a valid Solana address."); }
}

async function verifyPreparedTransaction(signature: string, encoded: string, signerWallet: string) {
  let bytes: Uint8Array;
  try { bytes = bs58.decode(signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (bytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "surety_transaction_unconfirmed", "The transaction must be confirmed on Solana before it can be recorded.");
  }
  const actual = await connection.getTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!actual || actual.meta?.err) throw new ApiError(409, "surety_transaction_unavailable", "Confirmed transaction details are not available yet.");
  const expected = Transaction.from(Buffer.from(encoded, "base64"));
  const matchesMessage = Buffer.from(actual.transaction.message.serialize()).equals(expected.compileMessage().serialize());
  const matchesSignature = actual.transaction.signatures.includes(signature);
  const signer = new PublicKey(signerWallet);
  const signedByWallet = actual.transaction.message.staticAccountKeys
    .slice(0, actual.transaction.message.header.numRequiredSignatures).some((key) => key.equals(signer));
  if (!matchesMessage || !matchesSignature || !signedByWallet) {
    throw new ApiError(422, "surety_transaction_mismatch", "The confirmed transaction does not match the exact Surety instructions prepared for this wallet.");
  }
}

async function commissionForSurety(commissionId: string, userId: string) {
  const result = await pool.query<{
    id: string; client_user_id: string; client_wallet: string; asset_mint: string; amount_atomic: string;
    status: string; deadline_at: Date; work_category: string; sla_hours: number | null; funding_signature: string | null;
  }>(
    `SELECT id, client_user_id, client_wallet, asset_mint, amount_atomic::text,
            status, deadline_at, work_category, sla_hours, funding_signature
       FROM commissions WHERE id = $1`, [commissionId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "commission_not_found", "Commission not found.");
  if (row.client_user_id !== userId) throw new ApiError(403, "commission_forbidden", "Only the commission client can insure its commission.");
  if (row.status !== "open" || row.funding_signature || row.deadline_at <= new Date()) {
    throw new ApiError(409, "surety_commission_unavailable", "Surety must be purchased before the commission is funded and before its deadline.");
  }
  return row;
}

async function rateForCommission(category: string, slaHours: number | null) {
  const result = await pool.query<{ overturn_rate: string | null; sample_size: string }>(
    `WITH settled AS (
       SELECT c.id,
              (tc.appealed_by IS NOT NULL AND tc.warden_verdict IS NOT NULL
                AND (CASE WHEN tc.outcome = 'dismissed' THEN 'provider' ELSE tc.outcome END)
                  <> (CASE WHEN tc.warden_verdict = 'dismissed' THEN 'provider' ELSE tc.warden_verdict END))::int AS overturned
         FROM commissions c JOIN work_records wr ON wr.commission_id = c.id
         JOIN tribunal_cases tc ON tc.commission_id = c.id AND tc.stage = 'decided'
        WHERE c.status IN ('complete', 'refunded') AND tc.appealed_by IS NOT NULL
          AND tc.warden_verdict IS NOT NULL AND c.work_category = $1
          AND ($2::smallint IS NULL OR c.sla_hours = $2)
     )
     SELECT (AVG(overturned) * 100)::text AS overturn_rate, COUNT(*)::text AS sample_size FROM settled`,
    [category, slaHours],
  );
  const sampleSize = Number(result.rows[0].sample_size);
  return { overturnRatePercent: sampleSize === 0 || result.rows[0].overturn_rate === null ? null : Number(result.rows[0].overturn_rate), sampleSize };
}

async function quoteCommission(commission: Awaited<ReturnType<typeof commissionForSurety>>, coverage: bigint) {
  if (coverage > BigInt(commission.amount_atomic)) throw new ApiError(400, "surety_coverage_too_high", "Coverage cannot exceed the commission amount.");
  const rate = await rateForCommission(commission.work_category, commission.sla_hours);
  const premiumRateBps = suretyPremiumRate(rate.overturnRatePercent);
  let premium = coverage * BigInt(premiumRateBps) / 10_000n;
  if (premium === 0n) premium = 1n;
  const treasuryFee = premium / 10n;
  return { coverageAtomic: coverage.toString(), premiumAtomic: premium.toString(), treasuryFeeAtomic: treasuryFee.toString(), premiumRateBps, ...rate };
}

suretyRouter.get("/pool", async (_request, response) => {
  try { response.json({ data: await suretyPoolOverview() }); }
  catch (error) {
    if (error instanceof ApiError && error.code === "surety_pool_not_initialized") {
      response.json({ data: { initialized: false, assetMint: config.USDC_MINT ?? null, cluster: config.SOLANA_CLUSTER } });
      return;
    }
    throw error;
  }
});

suretyRouter.post("/pool/deposit-instructions", requireAuth, async (request, response) => {
  const input = z.object({ amount: decimalAmount }).parse(request.body);
  const amount = toAtomic(input.amount);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const vault = await ensureSuretyPool(db);
    const sharesResult = await db.query<{ shares: string }>("SELECT COALESCE(sum(shares_atomic), 0)::text AS shares FROM surety_pool_share_accounts");
    const quotedShares = quotePoolShares(amount, BigInt(vault.accounted_balance_atomic), BigInt(sharesResult.rows[0].shares));
    const queued = await db.query("SELECT 1 FROM surety_withdrawal_requests WHERE state IN ('queued', 'processing', 'failed') LIMIT 1");
    if (queued.rowCount) throw new ApiError(409, "surety_withdrawal_queue_active", "New pool deposits are paused while queued underwriter withdrawals are being paid.");
    let row: {
      id: string; user_id: string; wallet_address: string; amount_atomic: string;
      recent_blockhash: string; last_valid_block_height: string; unsigned_transaction: string;
    } | undefined = (await db.query<{
      id: string; user_id: string; wallet_address: string; amount_atomic: string;
      recent_blockhash: string; last_valid_block_height: string; unsigned_transaction: string;
    }>("SELECT id, user_id, wallet_address, amount_atomic::text, recent_blockhash, last_valid_block_height::text, unsigned_transaction FROM surety_pool_deposits WHERE state = 'awaiting' AND user_id = $1 FOR UPDATE", [request.auth!.userId])).rows[0];
    const currentHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
    if (row && currentHeight > Number(row.last_valid_block_height)) {
      // Retire an expired request so it cannot reserve the pool's single
      // awaiting slot. Its exact transaction can still be confirmed later.
      await db.query("UPDATE surety_pool_deposits SET state = 'cancelled' WHERE id = $1", [row.id]);
      row = undefined;
    }
    if (row && (row.user_id !== request.auth!.userId || row.wallet_address !== request.auth!.walletAddress)) {
      throw new ApiError(409, "surety_deposit_pending", "Another underwriter has a deposit awaiting confirmation.");
    }
    if (row && BigInt(row.amount_atomic) !== amount) throw new ApiError(409, "surety_deposit_amount_conflict", "Confirm or expire the existing deposit before requesting another amount.");
    const sourceWallet = new PublicKey(request.auth!.walletAddress);
    const mint = new PublicKey(vault.asset_mint);
    const destinationWallet = new PublicKey(vault.wallet_public_key);
    if (row && currentHeight <= Number(row.last_valid_block_height)) {
      await db.query("COMMIT");
      response.json({ data: { depositId: row.id, amountAtomic: row.amount_atomic,
        unsignedTransaction: row.unsigned_transaction, lastValidBlockHeight: Number(row.last_valid_block_height),
        quotedSharesAtomic: quotedShares.toString(), poolWallet: vault.wallet_public_key, assetMint: vault.asset_mint } });
      return;
    }
    // A deposit whose blockhash expired cannot still be submitted. Unrelated
    // donations to the vault must not let one abandoned request lock the pool.
    const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
    const source = getAssociatedTokenAddressSync(mint, sourceWallet);
    const destination = getAssociatedTokenAddressSync(mint, destinationWallet);
    const transaction = new Transaction({ feePayer: sourceWallet, recentBlockhash: latest.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(sourceWallet, source, sourceWallet, mint),
      createAssociatedTokenAccountIdempotentInstruction(sourceWallet, destination, destinationWallet, mint),
      createTransferCheckedInstruction(source, mint, destination, sourceWallet, amount, 6, [], TOKEN_PROGRAM_ID),
    );
    const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    if (!row) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO surety_pool_deposits
           (user_id, wallet_address, amount_atomic, recent_blockhash, last_valid_block_height, unsigned_transaction)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [request.auth!.userId, sourceWallet.toBase58(), amount.toString(), latest.blockhash, latest.lastValidBlockHeight, unsigned],
      );
      row = { id: inserted.rows[0].id, user_id: request.auth!.userId, wallet_address: sourceWallet.toBase58(), amount_atomic: amount.toString(),
        recent_blockhash: latest.blockhash, last_valid_block_height: String(latest.lastValidBlockHeight), unsigned_transaction: unsigned };
    } else {
      await db.query(
        `UPDATE surety_pool_deposits SET recent_blockhash = $2, last_valid_block_height = $3, unsigned_transaction = $4 WHERE id = $1`,
        [row.id, latest.blockhash, latest.lastValidBlockHeight, unsigned],
      );
    }
    await db.query("COMMIT");
    response.json({ data: { depositId: row.id, amountAtomic: amount.toString(), unsignedTransaction: unsigned,
      quotedSharesAtomic: quotedShares.toString(), lastValidBlockHeight: latest.lastValidBlockHeight,
      poolWallet: vault.wallet_public_key, assetMint: vault.asset_mint } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.post("/pool/deposit-confirm", requireAuth, async (request, response) => {
  const input = z.object({ depositId: uuid, signature: z.string().min(80).max(100),
    minimumSharesAtomic: z.string().regex(/^(?:0|[1-9]\d{0,19})$/) }).parse(request.body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const result = await db.query<{
      id: string; user_id: string; wallet_address: string; amount_atomic: string; state: string;
      last_valid_block_height: string;
      transaction_signature: string | null; unsigned_transaction: string;
    }>("SELECT id, user_id, wallet_address, amount_atomic::text, state, last_valid_block_height::text, transaction_signature, unsigned_transaction FROM surety_pool_deposits WHERE id = $1 FOR UPDATE", [input.depositId]);
    const deposit = result.rows[0];
    if (!deposit) throw new ApiError(404, "surety_deposit_not_found", "Surety pool deposit not found.");
    if (deposit.user_id !== request.auth!.userId || deposit.wallet_address !== request.auth!.walletAddress) throw new ApiError(403, "surety_deposit_forbidden", "Only the depositing wallet can confirm this Surety contribution.");
    if (deposit.state === "confirmed") {
      if (deposit.transaction_signature !== input.signature) throw new ApiError(409, "surety_deposit_already_confirmed", "This deposit was confirmed by another transaction.");
      await db.query("COMMIT");
      response.json({ data: { depositId: deposit.id, confirmed: true }, idempotentReplay: true });
      return;
    }
    if (deposit.state !== "awaiting" && deposit.state !== "cancelled") throw new ApiError(409, "surety_deposit_closed", "This Surety deposit is no longer awaiting confirmation.");
    if (deposit.state === "cancelled" && await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(deposit.last_valid_block_height)) {
      throw new ApiError(409, "surety_deposit_closed", "This Surety deposit was cancelled and its transaction remains valid; wait for the blockhash to expire.");
    }
    await verifyPreparedTransaction(input.signature, deposit.unsigned_transaction, deposit.wallet_address);
    const poolRow = await loadSuretyPool();
    const actualBalance = await suretyPoolBalance(poolRow);
    const amount = BigInt(deposit.amount_atomic);
    if (actualBalance < BigInt(poolRow.accounted_balance_atomic) + amount) throw new ApiError(409, "surety_pool_balance_unavailable", "The confirmed deposit is not reflected in the Surety pool balance yet.");
    const total = await db.query<{ shares: string }>("SELECT COALESCE(sum(shares_atomic), 0)::text AS shares FROM surety_pool_share_accounts");
    const totalShares = BigInt(total.rows[0].shares);
    // Price shares from the ledger, not raw token balance: direct transfers to
    // the vault are donations and must not change an underwriter's share price.
    // Virtual assets/shares also make the initial price resistant to rounding
    // manipulation when the pool has very few shares.
    const accountedBefore = BigInt(poolRow.accounted_balance_atomic);
    const shares = quotePoolShares(amount, accountedBefore, totalShares);
    if (shares === 0n) throw new ApiError(409, "surety_deposit_too_small", "This deposit is too small to mint a positive pool share balance.");
    if (shares < BigInt(input.minimumSharesAtomic)) throw new ApiError(409, "surety_share_quote_moved", "The Surety pool share value moved below your minimum. Request a fresh deposit quote before confirming.");
    await db.query(
      `INSERT INTO surety_pool_share_accounts (user_id, shares_atomic) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET shares_atomic = surety_pool_share_accounts.shares_atomic + EXCLUDED.shares_atomic, updated_at = now()`,
      [deposit.user_id, shares.toString()],
    );
    await db.query("UPDATE surety_pool_deposits SET state = 'confirmed', shares_atomic = $2, transaction_signature = $3, confirmed_at = now() WHERE id = $1",
      [deposit.id, shares.toString(), input.signature]);
    await db.query("UPDATE surety_pool SET accounted_balance_atomic = accounted_balance_atomic + $1::numeric, updated_at = now() WHERE id = 1", [amount.toString()]);
    await db.query("COMMIT");
    response.status(201).json({ data: { depositId: deposit.id, confirmed: true, amountAtomic: amount.toString(), sharesAtomic: shares.toString() }, idempotentReplay: false });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.delete("/pool/deposits/:depositId", requireAuth, async (request, response) => {
  const depositId = uuid.parse(request.params.depositId);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const result = await db.query<{ id: string; user_id: string; wallet_address: string; state: string; last_valid_block_height: string }>(
      "SELECT id, user_id, wallet_address, state, last_valid_block_height::text FROM surety_pool_deposits WHERE id = $1 FOR UPDATE", [depositId],
    );
    const deposit = result.rows[0];
    if (!deposit) throw new ApiError(404, "surety_deposit_not_found", "Surety pool deposit not found.");
    if (deposit.user_id !== request.auth!.userId || deposit.wallet_address !== request.auth!.walletAddress) throw new ApiError(403, "surety_deposit_forbidden", "Only the depositing wallet can cancel this Surety contribution.");
    if (deposit.state !== "awaiting") throw new ApiError(409, "surety_deposit_closed", "This Surety deposit is no longer awaiting confirmation.");
    if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(deposit.last_valid_block_height)) throw new ApiError(409, "surety_transaction_still_valid", "Wait for the deposit transaction to confirm or expire before cancelling it.");
    await db.query("UPDATE surety_pool_deposits SET state = 'cancelled' WHERE id = $1", [deposit.id]);
    await db.query("COMMIT");
    response.json({ data: { depositId, state: "cancelled" } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.get("/pool/position", requireAuth, async (request, response) => {
  const result = await pool.query<{ shares_atomic: string; deposited_atomic: string; queued_shares: string }>(
    `SELECT COALESCE(a.shares_atomic, 0)::text AS shares_atomic,
            COALESCE((SELECT sum(d.amount_atomic) FROM surety_pool_deposits d WHERE d.user_id = $1 AND d.state = 'confirmed'), 0)::text AS deposited_atomic,
            COALESCE((SELECT sum(w.shares_atomic) FROM surety_withdrawal_requests w WHERE w.user_id = $1 AND w.state IN ('queued', 'processing', 'failed')), 0)::text AS queued_shares
       FROM (SELECT 1) singleton LEFT JOIN surety_pool_share_accounts a ON a.user_id = $1`, [request.auth!.userId],
  );
  const overview = await suretyPoolOverview().catch((error) => {
    if (error instanceof ApiError && error.code === "surety_pool_not_initialized") return null;
    throw error;
  });
  response.json({ data: { ...result.rows[0], pool: overview } });
});

suretyRouter.post("/pool/withdrawals", requireAuth, async (request, response) => {
  const { shares } = z.object({ shares: decimalAmount }).parse(request.body);
  const sharesAtomic = toAtomic(shares);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const account = await db.query<{ shares_atomic: string }>("SELECT shares_atomic::text FROM surety_pool_share_accounts WHERE user_id = $1 FOR UPDATE", [request.auth!.userId]);
    if (!account.rows[0]) throw new ApiError(404, "surety_shares_not_found", "This wallet has no Surety pool shares.");
    const queued = await db.query<{ shares: string }>(
      "SELECT COALESCE(sum(shares_atomic), 0)::text AS shares FROM surety_withdrawal_requests WHERE user_id = $1 AND state IN ('queued', 'processing', 'failed')", [request.auth!.userId],
    );
    if (BigInt(queued.rows[0].shares) + sharesAtomic > BigInt(account.rows[0].shares_atomic)) throw new ApiError(409, "surety_shares_insufficient", "The requested withdrawal exceeds unqueued Surety shares.");
    const overview = await suretyPoolOverview();
    if (BigInt(overview.totalSharesAtomic) === 0n || BigInt(overview.balanceAtomic) * sharesAtomic / BigInt(overview.totalSharesAtomic) === 0n) {
      throw new ApiError(409, "surety_withdrawal_value_zero", "The requested shares currently have no withdrawable USDC value.");
    }
    const inserted = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO surety_withdrawal_requests (user_id, wallet_address, shares_atomic)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [request.auth!.userId, request.auth!.walletAddress, sharesAtomic.toString()],
    );
    await db.query("COMMIT");
    response.status(202).json({ data: { id: inserted.rows[0].id, sharesAtomic: sharesAtomic.toString(), state: "queued", createdAt: inserted.rows[0].created_at } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.delete("/pool/withdrawals/:withdrawalId", requireAuth, async (request, response) => {
  const withdrawalId = uuid.parse(request.params.withdrawalId);
  const result = await pool.query(
    `UPDATE surety_withdrawal_requests SET state = 'cancelled', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND state = 'queued' RETURNING id`, [withdrawalId, request.auth!.userId],
  );
  if (!result.rowCount) throw new ApiError(409, "surety_withdrawal_not_cancellable", "Only your queued, unprocessed Surety withdrawal can be cancelled.");
  response.json({ data: { id: withdrawalId, state: "cancelled" } });
});

suretyRouter.post("/commissions/:commissionId/quote", requireAuth, async (request, response) => {
  const commissionId = uuid.parse(request.params.commissionId);
  const { coverage } = z.object({ coverage: decimalAmount }).parse(request.body);
  const commission = await commissionForSurety(commissionId, request.auth!.userId);
  const quote = await quoteCommission(commission, toAtomic(coverage));
  const vault = await loadSuretyPool();
  const balance = await suretyPoolBalance(vault);
  const reserved = await suretyReservedAtomic(pool);
  const available = balance > reserved ? balance - reserved : 0n;
  const queued = await pool.query("SELECT 1 FROM surety_withdrawal_requests WHERE state IN ('queued', 'processing', 'failed') LIMIT 1");
  response.json({ data: { commissionId, assetMint: vault.asset_mint, poolWallet: vault.wallet_public_key,
    ...quote, poolBalanceAtomic: balance.toString(), reservedAtomic: reserved.toString(),
    availableCoverAtomic: available.toString(), canBuy: !queued.rowCount && available >= BigInt(quote.coverageAtomic),
    pricingBasis: "settled Tribunal overturn rate by work category and SLA" } });
});

suretyRouter.post("/commissions/:commissionId/purchase-instructions", requireAuth, async (request, response) => {
  const commissionId = uuid.parse(request.params.commissionId);
  const { coverage } = z.object({ coverage: decimalAmount }).parse(request.body);
  const commission = await commissionForSurety(commissionId, request.auth!.userId);
  const coverageAtomic = toAtomic(coverage);
  const quote = await quoteCommission(commission, coverageAtomic);
  treasuryWallet();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const lockedCommission = await db.query<{ client_user_id: string; status: string; funding_signature: string | null; deadline_at: Date }>(
      "SELECT client_user_id, status, funding_signature, deadline_at FROM commissions WHERE id = $1 FOR UPDATE", [commissionId],
    );
    const currentCommission = lockedCommission.rows[0];
    if (!currentCommission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (currentCommission.client_user_id !== request.auth!.userId) throw new ApiError(403, "commission_forbidden", "Only the commission client can insure its commission.");
    if (currentCommission.status !== "open" || currentCommission.funding_signature || currentCommission.deadline_at <= new Date()) throw new ApiError(409, "surety_commission_unavailable", "Surety must be purchased before the commission is funded and before its deadline.");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const vault = await ensureSuretyPool(db);
    const withdrawals = await db.query("SELECT 1 FROM surety_withdrawal_requests WHERE state IN ('queued', 'processing', 'failed') LIMIT 1");
    if (withdrawals.rowCount) throw new ApiError(409, "surety_withdrawal_queue_active", "New policies are paused while underwriter withdrawals are queued.");
    const existing = await db.query<{
      id: string; state: string; coverage_atomic: string; premium_atomic: string;
      premium_unsigned_transaction: string | null; premium_recent_blockhash: string | null;
      premium_last_valid_block_height: string | null; premium_signature: string | null;
    }>("SELECT id, state, coverage_atomic::text, premium_atomic::text, premium_unsigned_transaction, premium_recent_blockhash, premium_last_valid_block_height::text, premium_signature FROM surety_policies WHERE commission_id = $1 FOR UPDATE", [commissionId]);
    const oldPolicy = existing.rows[0];
    if (oldPolicy && oldPolicy.state === "active") {
      if (BigInt(oldPolicy.coverage_atomic) !== coverageAtomic) throw new ApiError(409, "surety_policy_exists", "This commission already has active Surety coverage.");
      await db.query("COMMIT");
      response.json({ data: { commissionId, policyId: oldPolicy.id, state: oldPolicy.state, coverageAtomic: oldPolicy.coverage_atomic,
        premiumAtomic: oldPolicy.premium_atomic, premiumSignature: oldPolicy.premium_signature, idempotentReplay: true } });
      return;
    }
    if (oldPolicy && oldPolicy.state === "awaiting_premium" && oldPolicy.coverage_atomic !== coverageAtomic.toString()) {
      throw new ApiError(409, "surety_policy_pending", "Cancel or confirm the existing premium before requesting different coverage.");
    }
    if (oldPolicy && !["awaiting_premium", "cancelled"].includes(oldPolicy.state)) throw new ApiError(409, "surety_policy_closed", "This commission's Surety policy is already resolved.");
    const freshHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
    if (oldPolicy?.state === "awaiting_premium" && oldPolicy.premium_unsigned_transaction
      && oldPolicy.premium_last_valid_block_height && freshHeight <= Number(oldPolicy.premium_last_valid_block_height)) {
      await db.query("COMMIT");
      response.json({ data: { commissionId, policyId: oldPolicy.id, state: "awaiting_premium",
        coverageAtomic: oldPolicy.coverage_atomic, premiumAtomic: oldPolicy.premium_atomic,
        unsignedTransaction: oldPolicy.premium_unsigned_transaction,
        lastValidBlockHeight: Number(oldPolicy.premium_last_valid_block_height), idempotentReplay: true } });
      return;
    }
    const balance = await suretyPoolBalance(vault);
    if (oldPolicy?.state === "awaiting_premium" && balance > BigInt(vault.accounted_balance_atomic)) {
      throw new ApiError(409, "surety_premium_needs_confirmation", `A previous premium may have landed. Confirm its signature for commission ${commissionId} before requesting another transaction.`);
    }
    if (oldPolicy?.state === "awaiting_premium") {
      throw new ApiError(409, "surety_premium_expired", "The prepared premium transaction has expired. Cancel the pending policy before requesting a fresh payment instruction.");
    }
    const reserved = await suretyReservedAtomic(db);
    const available = balance > reserved ? balance - reserved : 0n;
    if (available < coverageAtomic) throw new ApiError(409, "surety_capacity_unavailable", "The USDC Surety pool does not have enough unreserved coverage capacity.");
    const mint = new PublicKey(vault.asset_mint);
    const payer = new PublicKey(request.auth!.walletAddress);
    const poolWallet = new PublicKey(vault.wallet_public_key);
    const source = getAssociatedTokenAddressSync(mint, payer);
    const destination = getAssociatedTokenAddressSync(mint, poolWallet);
    const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
    const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(payer, source, payer, mint),
      createAssociatedTokenAccountIdempotentInstruction(payer, destination, poolWallet, mint),
      createTransferCheckedInstruction(source, mint, destination, payer, BigInt(quote.premiumAtomic), 6, [], TOKEN_PROGRAM_ID),
    );
    const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const saved = await db.query<{ id: string }>(
      `INSERT INTO surety_policies
         (commission_id, client_user_id, client_wallet, work_category, sla_hours, coverage_atomic,
          premium_atomic, treasury_fee_atomic, premium_rate_bps, observed_overturn_rate_percent,
          rate_sample_size, state, expires_at, premium_unsigned_transaction, premium_recent_blockhash,
          premium_last_valid_block_height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'awaiting_premium', now() + interval '20 minutes', $12, $13, $14)
       ON CONFLICT (commission_id) DO UPDATE SET client_user_id = EXCLUDED.client_user_id,
          client_wallet = EXCLUDED.client_wallet, work_category = EXCLUDED.work_category,
          sla_hours = EXCLUDED.sla_hours, coverage_atomic = EXCLUDED.coverage_atomic,
          premium_atomic = EXCLUDED.premium_atomic, treasury_fee_atomic = EXCLUDED.treasury_fee_atomic,
          premium_rate_bps = EXCLUDED.premium_rate_bps,
          observed_overturn_rate_percent = EXCLUDED.observed_overturn_rate_percent,
          rate_sample_size = EXCLUDED.rate_sample_size, state = 'awaiting_premium',
          expires_at = EXCLUDED.expires_at, premium_unsigned_transaction = EXCLUDED.premium_unsigned_transaction,
          premium_recent_blockhash = EXCLUDED.premium_recent_blockhash,
          premium_last_valid_block_height = EXCLUDED.premium_last_valid_block_height,
          premium_signature = NULL, premium_confirmed_at = NULL, treasury_fee_paid = false, updated_at = now()
       WHERE surety_policies.state IN ('awaiting_premium', 'cancelled') RETURNING id`,
      [commissionId, request.auth!.userId, commission.client_wallet, commission.work_category, commission.sla_hours,
        coverageAtomic.toString(), quote.premiumAtomic, quote.treasuryFeeAtomic, quote.premiumRateBps,
        quote.overturnRatePercent, quote.sampleSize, unsigned, latest.blockhash, latest.lastValidBlockHeight],
    );
    if (!saved.rows[0]) throw new ApiError(409, "surety_policy_state_changed", "The Surety policy changed while the transaction was being prepared.");
    await db.query("COMMIT");
    response.status(201).json({ data: { commissionId, policyId: saved.rows[0].id, state: "awaiting_premium",
      assetMint: vault.asset_mint, poolWallet: vault.wallet_public_key, ...quote,
      unsignedTransaction: unsigned, lastValidBlockHeight: latest.lastValidBlockHeight, idempotentReplay: false } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.post("/commissions/:commissionId/premium-confirm", requireAuth, async (request, response) => {
  const commissionId = uuid.parse(request.params.commissionId);
  const { signature } = z.object({ signature: z.string().min(80).max(100) }).parse(request.body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const policyResult = await db.query<{
      id: string; client_user_id: string; client_wallet: string; premium_atomic: string;
      state: string; premium_signature: string | null; premium_unsigned_transaction: string | null;
    }>("SELECT id, client_user_id, client_wallet, premium_atomic::text, state, premium_signature, premium_unsigned_transaction FROM surety_policies WHERE commission_id = $1 FOR UPDATE", [commissionId]);
    const policy = policyResult.rows[0];
    if (!policy) throw new ApiError(404, "surety_policy_not_found", "No Surety policy exists for this commission.");
    if (policy.client_user_id !== request.auth!.userId || policy.client_wallet !== request.auth!.walletAddress) throw new ApiError(403, "surety_policy_forbidden", "Only the commission client can confirm this policy premium.");
    if (policy.state === "active") {
      if (policy.premium_signature !== signature) throw new ApiError(409, "surety_premium_already_confirmed", "This Surety premium was confirmed with another transaction.");
      await db.query("COMMIT");
      response.json({ data: { commissionId, policyId: policy.id, state: "active", premiumSignature: signature }, idempotentReplay: true });
      return;
    }
    if (policy.state !== "awaiting_premium" || !policy.premium_unsigned_transaction) throw new ApiError(409, "surety_policy_not_fundable", "This Surety policy is not awaiting its premium.");
    await verifyPreparedTransaction(signature, policy.premium_unsigned_transaction, policy.client_wallet);
    const vault = await loadSuretyPool();
    const actual = await suretyPoolBalance(vault);
    const premium = BigInt(policy.premium_atomic);
    if (actual < BigInt(vault.accounted_balance_atomic) + premium) throw new ApiError(409, "surety_premium_balance_unavailable", "The confirmed premium is not reflected in the Surety pool balance yet.");
    await db.query(
      `UPDATE surety_policies SET state = 'active', premium_signature = $2, premium_confirmed_at = now(), updated_at = now()
        WHERE id = $1`, [policy.id, signature],
    );
    await db.query("UPDATE surety_pool SET accounted_balance_atomic = accounted_balance_atomic + $1::numeric, updated_at = now() WHERE id = 1", [premium.toString()]);
    await db.query("COMMIT");
    response.status(201).json({ data: { commissionId, policyId: policy.id, state: "active", premiumSignature: signature }, idempotentReplay: false });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

suretyRouter.post("/commissions/:commissionId/policy-cancel", requireAuth, async (request, response) => {
  const commissionId = uuid.parse(request.params.commissionId);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const result = await db.query<{
      id: string; client_user_id: string; state: string; premium_last_valid_block_height: string | null;
    }>("SELECT id, client_user_id, state, premium_last_valid_block_height::text FROM surety_policies WHERE commission_id = $1 FOR UPDATE", [commissionId]);
    const policy = result.rows[0];
    if (!policy) throw new ApiError(404, "surety_policy_not_found", "No Surety policy exists for this commission.");
    if (policy.client_user_id !== request.auth!.userId) throw new ApiError(403, "surety_policy_forbidden", "Only the commission client can cancel this policy.");
    if (policy.state !== "awaiting_premium") throw new ApiError(409, "surety_policy_not_cancellable", "Only an unpaid Surety policy can be cancelled.");
    if (policy.premium_last_valid_block_height && await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(policy.premium_last_valid_block_height)) {
      throw new ApiError(409, "surety_transaction_still_valid", "Wait for the premium transaction to confirm or expire before cancelling the policy.");
    }
    const vault = await loadSuretyPool();
    const actual = await suretyPoolBalance(vault);
    if (actual > BigInt(vault.accounted_balance_atomic)) throw new ApiError(409, "surety_premium_needs_confirmation", "A premium may have landed. Confirm its signature before cancelling the policy.");
    await db.query("UPDATE surety_policies SET state = 'cancelled', updated_at = now() WHERE id = $1", [policy.id]);
    await db.query("COMMIT");
    response.json({ data: { commissionId, policyId: policy.id, state: "cancelled" } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});
