import { Keypair, PublicKey, Transaction, Connection } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { decryptSolanaSecretKey } from "./escrow-wallets.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { ApiError } from "./http.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

type WithdrawalAttempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

async function confirmWithdrawal(withdrawalId: string, attemptId: string, userId: string, stakeAddress: string, mint: string) {
  const stakeAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(stakeAddress));
  const accountInfo = await connection.getAccountInfo(stakeAta, config.SOLANA_COMMITMENT);
  const balanceAtomic = accountInfo
    ? (await connection.getTokenAccountBalance(stakeAta, config.SOLANA_COMMITMENT)).value.amount
    : "0";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE evaluator_stake_withdrawal_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    await client.query("UPDATE evaluator_stake_withdrawals SET state = 'confirmed', updated_at = now() WHERE id = $1", [withdrawalId]);
    // A stake deposit can be confirmed after this withdrawal was prepared. Reflect
    // the confirmed on-chain balance so a residual deposit is neither hidden nor
    // left unusable behind an inactive evaluator profile.
    await client.query(
      "UPDATE evaluator_profiles SET stake_atomic = $2, active = ($2::numeric > 0), updated_at = now() WHERE user_id = $1",
      [userId, balanceAtomic],
    );
    await client.query("COMMIT");
    return balanceAtomic;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withdrawEvaluatorStake(userId: string, idempotencyKey: string) {
  const db = await pool.connect();
  let locked = false;
  let profileDeactivated = false;
  let durableWithdrawalExists = false;
  let observedStakeBalance: string | null = null;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`evaluator-stake:${userId}`]);
    locked = true;
    const found = await db.query<{
      wallet_address: string; stake_wallet_public_key: string; stake_mint: string; stake_atomic: string;
      encrypted_secret_key: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer; encryption_key_version: number;
    }>(
      `SELECT u.wallet_address, e.stake_wallet_public_key, e.stake_mint, e.stake_atomic,
              e.encrypted_secret_key, e.encryption_nonce, e.encryption_auth_tag, e.encryption_key_version
         FROM wallet_users u JOIN evaluator_profiles e ON e.user_id = u.id WHERE u.id = $1 FOR UPDATE OF e`, [userId],
    );
    const profile = found.rows[0];
    if (!profile) throw new ApiError(404, "evaluator_profile_not_found", "Register as an evaluator and deposit stake before withdrawing.");
    const activeAssignments = await db.query(
      "SELECT 1 FROM tribunal_assignments WHERE user_id = $1 AND released_at IS NULL LIMIT 1", [userId],
    );
    if (activeAssignments.rowCount) throw new ApiError(409, "evaluator_cases_active", "Stake cannot be withdrawn while Tribunal assignments are open.");
    const activeBountyAssignments = await db.query(
      "SELECT 1 FROM bounty_evaluator_assignments WHERE user_id = $1 AND released_at IS NULL LIMIT 1", [userId],
    );
    if (activeBountyAssignments.rowCount) throw new ApiError(409, "evaluator_bounties_active", "Stake cannot be withdrawn while you are assigned to rank an open bounty.");
    const pendingSlash = await db.query(
      `SELECT 1 FROM evaluator_slash_operations WHERE evaluator_user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown')
       UNION ALL
       SELECT 1 FROM tribunal_cases tc WHERE tc.warden_user_id = $1
         AND (tc.stage IN ('panel', 'bench') OR
              (tc.stage = 'decided' AND tc.panel_decided_at IS NOT NULL AND tc.outcome IS NOT NULL
               AND (CASE WHEN tc.warden_verdict = 'dismissed' THEN 'provider' ELSE tc.warden_verdict END)
                 <> (CASE WHEN tc.outcome = 'dismissed' THEN 'provider' ELSE tc.outcome END))
              OR (tc.stage = 'warden' AND tc.warden_verdict IS NOT NULL AND tc.appeal_deadline_at > now()))
       LIMIT 1`, [userId],
    );
    if (pendingSlash.rowCount) throw new ApiError(409, "evaluator_slash_pending", "Wait for pending stake slashes to finish before withdrawing.");
    const feePayer = loadSolanaFeePayer();
    const existing = await db.query<{ id: string; state: string; amount_atomic: string; transaction_signature: string | null }>(
      "SELECT id, state, amount_atomic, transaction_signature FROM evaluator_stake_withdrawals WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE",
      [userId, idempotencyKey],
    );
    let withdrawal = existing.rows[0];
    if (withdrawal?.state === "confirmed") {
      return { state: "confirmed" as const, signature: withdrawal.transaction_signature, amountAtomic: withdrawal.amount_atomic };
    }
    if (!withdrawal) {
      const inFlight = await db.query(
        "SELECT 1 FROM evaluator_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1", [userId],
      );
      if (inFlight.rowCount) throw new ApiError(409, "evaluator_withdrawal_in_progress", "Resolve the evaluator's current stake withdrawal before creating another one.");
      // Serialize deactivation against evaluator assignment. Assignment queries
      // lock this profile row with SKIP LOCKED, so no new case can slip in once
      // this transaction commits the inactive state.
      await db.query("BEGIN");
      try {
        await db.query("SELECT user_id FROM evaluator_profiles WHERE user_id = $1 FOR UPDATE", [userId]);
        const [tribunalAssignments, bountyAssignments] = await Promise.all([
          db.query("SELECT 1 FROM tribunal_assignments WHERE user_id = $1 AND released_at IS NULL LIMIT 1", [userId]),
          db.query("SELECT 1 FROM bounty_evaluator_assignments WHERE user_id = $1 AND released_at IS NULL LIMIT 1", [userId]),
        ]);
        if (tribunalAssignments.rowCount) throw new ApiError(409, "evaluator_cases_active", "Stake cannot be withdrawn while Tribunal assignments are open.");
        if (bountyAssignments.rowCount) throw new ApiError(409, "evaluator_bounties_active", "Stake cannot be withdrawn while you are assigned to rank an open bounty.");
        await db.query("UPDATE evaluator_profiles SET active = false, updated_at = now() WHERE user_id = $1", [userId]);
        await db.query("COMMIT");
        profileDeactivated = true;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      const mint = new PublicKey(profile.stake_mint);
      const stakeWallet = new PublicKey(profile.stake_wallet_public_key);
      const source = getAssociatedTokenAddressSync(mint, stakeWallet);
      const balance = await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT);
      observedStakeBalance = balance.value.amount;
      const amount = BigInt(balance.value.amount);
      if (amount <= 0n) throw new ApiError(409, "evaluator_stake_empty", "The evaluator stake account has no tokens to withdraw.");
      const created = await db.query<{ id: string; state: string; amount_atomic: string; transaction_signature: string | null }>(
        `INSERT INTO evaluator_stake_withdrawals (user_id, idempotency_key, destination_wallet, amount_atomic)
         VALUES ($1, $2, $3, $4) RETURNING id, state, amount_atomic, transaction_signature`,
        [userId, idempotencyKey, profile.wallet_address, amount.toString()],
      );
      withdrawal = created.rows[0];
      durableWithdrawalExists = true;
    }
    if (!withdrawal) throw new Error("Could not create or load evaluator stake withdrawal.");
    let attempts = await db.query<WithdrawalAttempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM evaluator_stake_withdrawal_attempts WHERE withdrawal_id = $1 ORDER BY created_at DESC LIMIT 1`, [withdrawal.id],
    );
    let attempt: WithdrawalAttempt | undefined = attempts.rows[0];
    if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE evaluator_stake_withdrawal_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_stake_withdrawals SET state = 'failed' WHERE id = $1", [withdrawal.id]);
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        const balance = await confirmWithdrawal(withdrawal.id, attempt.id, userId, profile.stake_wallet_public_key, profile.stake_mint);
        return { state: "confirmed" as const, signature: attempt.transaction_signature, amountAtomic: withdrawal.amount_atomic, remainingStakeAtomic: balance };
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE evaluator_stake_withdrawal_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_stake_withdrawals SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [withdrawal.id, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature, amountAtomic: withdrawal.amount_atomic };
      } else {
        await db.query("UPDATE evaluator_stake_withdrawal_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_stake_withdrawals SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [withdrawal.id]);
        throw new ApiError(409, "evaluator_withdrawal_outcome_unknown", "The stake withdrawal expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
      }
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(profile.stake_mint);
      const stakeWallet = new PublicKey(profile.stake_wallet_public_key);
      const recipient = new PublicKey(profile.wallet_address);
      const source = getAssociatedTokenAddressSync(mint, stakeWallet);
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const actualBalance = await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT);
      const amount = BigInt(actualBalance.value.amount);
      if (amount <= 0n) throw new ApiError(409, "evaluator_stake_empty", "The evaluator stake account has no tokens to withdraw.");
      const secret = decryptSolanaSecretKey({ ciphertext: profile.encrypted_secret_key,
        nonce: profile.encryption_nonce, authTag: profile.encryption_auth_tag, keyVersion: profile.encryption_key_version });
      const stakeKey = Keypair.fromSecretKey(secret);
      if (!stakeKey.publicKey.equals(stakeWallet)) throw new Error("Evaluator stake key does not match its recorded address.");
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest }).add(
        createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, stakeWallet, amount, 6, [], TOKEN_PROGRAM_ID),
        createCloseAccountInstruction(source, recipient, stakeWallet, [], TOKEN_PROGRAM_ID),
      );
      transaction.partialSign(feePayer, stakeKey);
      if (!transaction.signature) throw new Error("Signed stake withdrawal has no signature.");
      const signature = bs58.encode(transaction.signature);
      const signedTransaction = transaction.serialize();
      const saved = await db.query<{ id: string }>(
        `INSERT INTO evaluator_stake_withdrawal_attempts
           (withdrawal_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [withdrawal.id, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: saved.rows[0].id, transaction_signature: signature, signed_transaction: signedTransaction,
        last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
      await db.query("UPDATE evaluator_stake_withdrawals SET amount_atomic = $2, state = 'pending' WHERE id = $1", [withdrawal.id, amount.toString()]);
      withdrawal.amount_atomic = amount.toString();
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE evaluator_stake_withdrawal_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE evaluator_stake_withdrawals SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [withdrawal.id, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature, amountAtomic: withdrawal.amount_atomic };
  } finally {
    if (profileDeactivated && !durableWithdrawalExists) {
      // Failures before the durable queue row exists must not strand a funded
      // evaluator as inactive. If the database itself is unavailable, keep the
      // safer inactive state and let an operator reconcile it.
      try {
        const saved = await db.query("SELECT 1 FROM evaluator_stake_withdrawals WHERE user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
        if (!saved.rowCount) {
          await db.query(
            `UPDATE evaluator_profiles SET stake_atomic = COALESCE($2::numeric, stake_atomic),
               active = (COALESCE($2::numeric, stake_atomic) > 0), updated_at = now()
             WHERE user_id = $1`, [userId, observedStakeBalance],
          );
        }
      } catch { /* preserve the original result; profile remains inactive */ }
    }
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`evaluator-stake:${userId}`]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileEvaluatorStakeWithdrawals(limit = 25) {
  const due = await pool.query<{ user_id: string; idempotency_key: string }>(
    `SELECT user_id, idempotency_key FROM evaluator_stake_withdrawals
      WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown') ORDER BY updated_at LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { userId: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const result = await withdrawEvaluatorStake(row.user_id, row.idempotency_key);
      if (result.state === "confirmed") confirmed += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({ userId: row.user_id, code: error instanceof ApiError ? error.code : "withdrawal_error" });
    }
  }
  return { examined: due.rows.length, confirmed, submitted, errors };
}
