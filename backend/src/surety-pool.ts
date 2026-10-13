import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { createEncryptedSolanaWallet, decryptSolanaSecretKey } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
type SuretyPool = {
  wallet_public_key: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
  encryption_auth_tag: Buffer; encryption_key_version: number; cluster: string; asset_mint: string;
  accounted_balance_atomic: string;
};
type Attempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

export function suretyUsdcMint() {
  if (!config.USDC_MINT) throw new ApiError(503, "surety_unavailable", "USDC is not configured for the Surety pool.");
  try { return new PublicKey(config.USDC_MINT).toBase58(); }
  catch { throw new ApiError(503, "surety_misconfigured", "USDC_MINT is not a valid Solana address."); }
}

export async function ensureSuretyPool(db: PoolClient): Promise<SuretyPool> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
  const existing = await db.query<SuretyPool>("SELECT * FROM surety_pool WHERE id = 1 FOR UPDATE");
  if (existing.rows[0]) {
    if (existing.rows[0].cluster !== config.SOLANA_CLUSTER || existing.rows[0].asset_mint !== suretyUsdcMint()) {
      throw new ApiError(409, "surety_cluster_mismatch", "The Surety pool was created for a different Solana cluster or USDC mint.");
    }
    return existing.rows[0];
  }
  const wallet = createEncryptedSolanaWallet();
  const inserted = await db.query<SuretyPool>(
    `INSERT INTO surety_pool
       (id, wallet_public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag,
        encryption_key_version, cluster, asset_mint)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce, wallet.encryptionAuthTag,
      wallet.encryptionKeyVersion, config.SOLANA_CLUSTER, suretyUsdcMint()],
  );
  return inserted.rows[0];
}

export async function loadSuretyPool(): Promise<SuretyPool> {
  const result = await pool.query<SuretyPool>("SELECT * FROM surety_pool WHERE id = 1");
  if (!result.rows[0]) throw new ApiError(404, "surety_pool_not_initialized", "The Surety pool has not been initialized yet.");
  return result.rows[0];
}

export async function suretyPoolBalance(poolRow: SuretyPool) {
  const mint = new PublicKey(poolRow.asset_mint);
  const vault = new PublicKey(poolRow.wallet_public_key);
  const account = getAssociatedTokenAddressSync(mint, vault);
  const info = await connection.getAccountInfo(account, config.SOLANA_COMMITMENT);
  if (!info) return 0n;
  const balance = await connection.getTokenAccountBalance(account, config.SOLANA_COMMITMENT);
  if (balance.value.decimals !== 6) throw new ApiError(422, "surety_asset_decimals", "The configured USDC mint must use six decimals.");
  return BigInt(balance.value.amount);
}

export async function suretyReservedAtomic(db: PoolClient | typeof pool) {
  const result = await db.query<{ amount: string }>(
    `SELECT COALESCE(sum(coverage_atomic), 0)::text AS amount FROM surety_policies
      WHERE state IN ('awaiting_premium', 'active', 'claim_pending', 'claim_submitted')`,
  );
  return BigInt(result.rows[0].amount);
}

export function suretyPremiumRate(overturnRatePercent: number | null) {
  const risk = overturnRatePercent === null ? 0
    : Math.ceil(overturnRatePercent * config.SURETY_OVERTURN_RISK_BPS / 100);
  return Math.min(config.SURETY_MAX_PREMIUM_BPS, config.SURETY_BASE_PREMIUM_BPS + risk);
}

export async function reconcileSuretyPolicies(limit = 50) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-surety-pool'))");
    const due = await db.query<{
      id: string; commission_id: string; state: string; premium_atomic: string; treasury_fee_atomic: string;
      client_wallet: string; commission_status: string; deadline_at: Date; tribunal_outcome: string | null;
    }>(
      `SELECT p.id, p.commission_id, p.state, p.premium_atomic::text, p.treasury_fee_atomic::text,
              p.client_wallet, c.status AS commission_status, c.deadline_at,
              (SELECT tc.outcome FROM tribunal_cases tc WHERE tc.commission_id = c.id AND tc.stage = 'decided' LIMIT 1) AS tribunal_outcome
         FROM surety_policies p JOIN commissions c ON c.id = p.commission_id
        WHERE p.state = 'active' AND (
          c.status IN ('complete', 'refunded') OR (c.status = 'open' AND c.deadline_at <= now())
        ) ORDER BY p.created_at LIMIT $1 FOR UPDATE OF p SKIP LOCKED`, [limit],
    );
    let released = 0;
    let claims = 0;
    let refunds = 0;
    for (const row of due.rows) {
      const neverFunded = row.commission_status === "open" && row.deadline_at <= new Date();
      if (neverFunded) {
        await db.query("UPDATE surety_policies SET state = 'refunded', updated_at = now() WHERE id = $1", [row.id]);
        await db.query(
          `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic)
           VALUES ('premium_refund', $1, $2, $3) ON CONFLICT (kind, reference_id) DO NOTHING`,
          [row.id, row.client_wallet, row.premium_atomic],
        );
        refunds += 1;
        continue;
      }
      if (row.commission_status === "refunded" && row.tribunal_outcome === "client") {
        await db.query("UPDATE surety_policies SET state = 'claim_pending', updated_at = now() WHERE id = $1", [row.id]);
        await db.query(
          `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic)
           SELECT 'claim', p.id, p.client_wallet, p.coverage_atomic FROM surety_policies p WHERE p.id = $1
           ON CONFLICT (kind, reference_id) DO NOTHING`, [row.id],
        );
        claims += 1;
      } else {
        await db.query("UPDATE surety_policies SET state = 'released', updated_at = now() WHERE id = $1", [row.id]);
        released += 1;
      }
      if (BigInt(row.treasury_fee_atomic) > 0n) {
        if (!config.TREASURY_WALLET) throw new ApiError(503, "surety_treasury_unavailable", "TREASURY_WALLET is required to settle Surety premiums.");
        let treasuryWallet: string;
        try { treasuryWallet = new PublicKey(config.TREASURY_WALLET).toBase58(); }
        catch { throw new ApiError(503, "surety_treasury_misconfigured", "TREASURY_WALLET is not a valid Solana address."); }
        await db.query(
          `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic)
           VALUES ('premium_fee', $1, $2, $3) ON CONFLICT (kind, reference_id) DO NOTHING`,
          [row.id, treasuryWallet, row.treasury_fee_atomic],
        );
      } else {
        await db.query("UPDATE surety_policies SET treasury_fee_paid = true WHERE id = $1", [row.id]);
      }
    }
    await db.query("COMMIT");
    return { examined: due.rows.length, released, claims, refunds };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

async function markOperationConfirmed(operation: {
  id: string; kind: string; reference_id: string; amount_atomic: string; shares_atomic: string | null;
}, attemptId: string, signature: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE surety_pool_operation_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    await db.query("UPDATE surety_pool_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, signature]);
    const balance = await db.query(
      `UPDATE surety_pool SET accounted_balance_atomic = accounted_balance_atomic - $1::numeric, updated_at = now()
        WHERE id = 1 AND accounted_balance_atomic >= $1::numeric RETURNING id`, [operation.amount_atomic],
    );
    if (!balance.rowCount) throw new Error("Surety pool accounted balance would become negative.");
    if (operation.kind === "claim") {
      await db.query("UPDATE surety_policies SET state = 'claimed', updated_at = now() WHERE id = $1 AND state = 'claim_pending'", [operation.reference_id]);
    } else if (operation.kind === "premium_fee") {
      await db.query("UPDATE surety_policies SET treasury_fee_paid = true, updated_at = now() WHERE id = $1", [operation.reference_id]);
    } else if (operation.kind === "premium_refund") {
      await db.query("UPDATE surety_policies SET state = 'refunded', updated_at = now() WHERE id = $1", [operation.reference_id]);
    } else if (operation.kind === "withdrawal") {
      const request = await db.query<{ user_id: string; state: string }>(
        "SELECT user_id, state FROM surety_withdrawal_requests WHERE id = $1 FOR UPDATE", [operation.reference_id],
      );
      if (!request.rows[0] || request.rows[0].state !== "processing" || !operation.shares_atomic) throw new Error("Surety withdrawal request state is invalid.");
      const shares = await db.query(
        `UPDATE surety_pool_share_accounts SET shares_atomic = shares_atomic - $2::numeric, updated_at = now()
          WHERE user_id = $1 AND shares_atomic >= $2::numeric RETURNING user_id`, [request.rows[0].user_id, operation.shares_atomic],
      );
      if (!shares.rowCount) throw new Error("Surety withdrawal exceeds the account's remaining shares.");
      await db.query("UPDATE surety_withdrawal_requests SET state = 'confirmed', updated_at = now() WHERE id = $1", [operation.reference_id]);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

async function prepareNextWithdrawal(db: PoolClient) {
  const active = await db.query("SELECT 1 FROM surety_policies WHERE state IN ('awaiting_premium', 'active', 'claim_pending', 'claim_submitted') LIMIT 1");
  if (active.rowCount) return false;
  const obligations = await db.query("SELECT 1 FROM surety_pool_operations WHERE kind <> 'withdrawal' AND state IN ('queued', 'submitted', 'failed', 'outcome_unknown') LIMIT 1");
  if (obligations.rowCount) return false;
  const outstanding = await db.query("SELECT 1 FROM surety_pool_operations WHERE state IN ('submitted', 'outcome_unknown') LIMIT 1");
  if (outstanding.rowCount) return false;
  const pendingWithdrawal = await db.query("SELECT 1 FROM surety_pool_operations WHERE kind = 'withdrawal' AND state IN ('queued', 'submitted', 'failed', 'outcome_unknown') LIMIT 1");
  if (pendingWithdrawal.rowCount) return false;
  const queued = await db.query<{ id: string; user_id: string; shares_atomic: string }>(
    `SELECT id, user_id, shares_atomic::text FROM surety_withdrawal_requests
      WHERE state = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
  );
  const request = queued.rows[0];
  if (!request) return false;
  const poolRow = await db.query<SuretyPool>("SELECT * FROM surety_pool WHERE id = 1 FOR UPDATE");
  if (!poolRow.rows[0]) return false;
  const tokenBalance = await suretyPoolBalance(poolRow.rows[0]);
  const shares = await db.query<{ total: string; own: string }>(
    `SELECT COALESCE(sum(shares_atomic), 0)::text AS total,
            COALESCE((SELECT shares_atomic FROM surety_pool_share_accounts WHERE user_id = $1), 0)::text AS own
       FROM surety_pool_share_accounts`, [request.user_id],
  );
  const totalShares = BigInt(shares.rows[0].total);
  const ownShares = BigInt(shares.rows[0].own);
  const requestShares = BigInt(request.shares_atomic);
  if (requestShares > ownShares || totalShares <= 0n) throw new Error("Queued Surety withdrawal no longer has enough shares.");
  const amount = tokenBalance * requestShares / totalShares;
  if (amount === 0n) {
    await db.query("UPDATE surety_pool_share_accounts SET shares_atomic = shares_atomic - $2::numeric, updated_at = now() WHERE user_id = $1", [request.user_id, request.shares_atomic]);
    await db.query("UPDATE surety_withdrawal_requests SET state = 'wiped', updated_at = now() WHERE id = $1", [request.id]);
    return true;
  }
  const inserted = await db.query(
    `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic, shares_atomic)
     VALUES ('withdrawal', $1, (SELECT wallet_address FROM surety_withdrawal_requests WHERE id = $1), $2, $3)
     ON CONFLICT (kind, reference_id) DO NOTHING RETURNING id`, [request.id, amount.toString(), request.shares_atomic],
  );
  if (inserted.rowCount) await db.query("UPDATE surety_withdrawal_requests SET state = 'processing', updated_at = now() WHERE id = $1", [request.id]);
  return Boolean(inserted.rowCount);
}

async function submitPoolOperation(operationId: string) {
  const db = await pool.connect();
  try {
    const result = await db.query<{
      id: string; kind: string; reference_id: string; destination_wallet: string; amount_atomic: string;
      shares_atomic: string | null; state: string; transaction_signature: string | null;
    }>("SELECT * FROM surety_pool_operations WHERE id = $1 FOR UPDATE", [operationId]);
    const operation = result.rows[0];
    if (!operation) throw new Error("Surety pool operation was not found.");
    if (operation.state === "confirmed") return { state: "confirmed" as const };
    const poolResult = await db.query<SuretyPool>("SELECT * FROM surety_pool WHERE id = 1");
    const poolRow = poolResult.rows[0];
    if (!poolRow || poolRow.cluster !== config.SOLANA_CLUSTER) throw new ApiError(409, "surety_cluster_mismatch", "Surety pool cluster does not match this API.");
    const attempts = await db.query<Attempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM surety_pool_operation_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operationId],
    );
    let attempt: Attempt | undefined = attempts.rows[0];
    if (operation.state === "outcome_unknown") {
      if (!attempt) throw new ApiError(409, "surety_payout_outcome_unknown", "The Surety pool transfer outcome is unknown and must be reconciled before another transfer is prepared.");
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await markOperationConfirmed(operation, attempt.id, attempt.transaction_signature);
        return { state: "confirmed" as const };
      }
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE surety_pool_operation_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE surety_pool_operations SET state = 'failed', updated_at = now() WHERE id = $1", [operation.id]);
        return { state: "failed" as const };
      }
      throw new ApiError(409, "surety_payout_outcome_unknown", "The Surety pool transfer outcome remains unknown; no replacement transfer will be prepared.");
    }
    if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE surety_pool_operation_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE surety_pool_operations SET state = 'failed', updated_at = now() WHERE id = $1", [operation.id]);
        return { state: "failed" as const };
      }
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await markOperationConfirmed(operation, attempt.id, attempt.transaction_signature);
        return { state: "confirmed" as const };
      }
      if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE surety_pool_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE surety_pool_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature };
      }
      await db.query("UPDATE surety_pool_operation_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
      await db.query("UPDATE surety_pool_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [operation.id]);
      throw new ApiError(409, "surety_payout_outcome_unknown", "The Surety pool transfer expired but its Solana outcome could not be verified. No replacement transfer was prepared.");
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(poolRow.asset_mint);
      const vault = new PublicKey(poolRow.wallet_public_key);
      const source = getAssociatedTokenAddressSync(mint, vault);
      const available = await suretyPoolBalance(poolRow);
      if (available < BigInt(operation.amount_atomic)) throw new ApiError(409, "surety_pool_liquidity_low", "The Surety pool does not currently have enough liquid USDC for this obligation.");
      const secret = decryptSolanaSecretKey({ ciphertext: poolRow.encrypted_secret_key,
        nonce: poolRow.encryption_nonce, authTag: poolRow.encryption_auth_tag,
        keyVersion: poolRow.encryption_key_version });
      const vaultKey = Keypair.fromSecretKey(secret);
      if (!vaultKey.publicKey.equals(vault)) throw new Error("Surety pool EOA key does not match its recorded address.");
      const recipient = new PublicKey(operation.destination_wallet);
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const payer = loadSolanaFeePayer();
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, vault, BigInt(operation.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
      );
      transaction.partialSign(payer, vaultKey);
      if (!transaction.signature) throw new Error("Signed Surety payout has no transaction signature.");
      const signature = bs58.encode(transaction.signature);
      const signed = transaction.serialize();
      const saved = await db.query<{ id: string }>(
        `INSERT INTO surety_pool_operation_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [operation.id, signature, signed, latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: saved.rows[0].id, transaction_signature: signature, signed_transaction: signed,
        last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE surety_pool_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE surety_pool_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature };
  } finally { db.release(); }
}

export async function reconcileSuretyPool(limit = 25) {
  const result = { policies: { examined: 0, released: 0, claims: 0, refunds: 0 }, operations: { examined: 0, confirmed: 0, submitted: 0, errors: [] as { operationId: string; code: string }[] } };
  result.policies = await reconcileSuretyPolicies(limit);
  const db = await pool.connect();
  let locked = false;
  let poolLocked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-surety-reconcile')) AS acquired");
    if (!lock.rows[0]?.acquired) return result;
    locked = true;
    const poolLock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-surety-pool')) AS acquired");
    if (!poolLock.rows[0]?.acquired) return result;
    poolLocked = true;
    const pendingDeposit = await db.query("SELECT 1 FROM surety_pool_deposits WHERE state = 'awaiting' LIMIT 1");
    if (!pendingDeposit.rowCount) {
      const withdrawals = await db.query("SELECT 1 FROM surety_pool_operations WHERE kind = 'withdrawal' AND state IN ('submitted', 'outcome_unknown') LIMIT 1");
      if (!withdrawals.rowCount) await prepareNextWithdrawal(db);
    }
    const due = await db.query<{ id: string }>(
      `SELECT id FROM surety_pool_operations
        WHERE state IN ('queued', 'submitted', 'failed', 'outcome_unknown') AND ($2::boolean = false OR state IN ('submitted', 'outcome_unknown'))
        ORDER BY CASE kind WHEN 'claim' THEN 0 WHEN 'premium_refund' THEN 1 WHEN 'premium_fee' THEN 2 ELSE 3 END, created_at
        LIMIT $1`, [limit, Boolean(pendingDeposit.rowCount)],
    );
    result.operations.examined = due.rows.length;
    for (const operation of due.rows) {
      try {
        const submitted = await submitPoolOperation(operation.id);
        if (submitted.state === "confirmed") result.operations.confirmed += 1;
        else if (submitted.state === "submitted") {
          result.operations.submitted += 1;
          break;
        } else if (submitted.state === "failed") {
          result.operations.errors.push({ operationId: operation.id, code: "surety_transaction_failed" });
          break;
        }
      } catch (error) {
        await db.query("UPDATE surety_pool_operations SET updated_at = now() WHERE id = $1", [operation.id]);
        result.operations.errors.push({ operationId: operation.id, code: error instanceof ApiError ? error.code : "surety_operation_error" });
        break;
      }
    }
    return result;
  } finally {
    if (poolLocked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-surety-pool'))").catch(() => undefined);
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-surety-reconcile'))").catch(() => undefined);
    db.release();
  }
}

export async function suretyPoolOverview() {
  const poolRow = await loadSuretyPool();
  const [balance, reserved, shares, policies, queue] = await Promise.all([
    suretyPoolBalance(poolRow),
    pool.query<{ total: string }>("SELECT COALESCE(sum(coverage_atomic), 0)::text AS total FROM surety_policies WHERE state IN ('awaiting_premium', 'active', 'claim_pending', 'claim_submitted')"),
    pool.query<{ total: string }>("SELECT COALESCE(sum(shares_atomic), 0)::text AS total FROM surety_pool_share_accounts"),
    pool.query<{ count: string }>("SELECT count(*)::text AS count FROM surety_policies WHERE state IN ('active', 'claim_pending', 'claim_submitted')"),
    pool.query<{ count: string }>("SELECT count(*)::text AS count FROM surety_withdrawal_requests WHERE state IN ('queued', 'processing', 'failed')"),
  ]);
  const reservedAtomic = BigInt(reserved.rows[0].total);
  return {
    walletAddress: poolRow.wallet_public_key,
    assetMint: poolRow.asset_mint,
    balanceAtomic: balance.toString(),
    accountedBalanceAtomic: poolRow.accounted_balance_atomic,
    reservedAtomic: reservedAtomic.toString(),
    availableAtomic: (balance > reservedAtomic ? balance - reservedAtomic : 0n).toString(),
    totalSharesAtomic: shares.rows[0].total,
    activePolicies: Number(policies.rows[0].count),
    queuedWithdrawals: Number(queue.rows[0].count),
  };
}
