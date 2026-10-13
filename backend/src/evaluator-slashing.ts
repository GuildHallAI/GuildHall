import { Keypair, PublicKey, Transaction, Connection } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
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

type SlashAttempt = {
  id: string;
  transaction_signature: string;
  signed_transaction: Buffer;
  last_valid_block_height: string;
  state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

function effectiveVerdict(value: string) {
  return value === "dismissed" ? "provider" : value;
}

async function confirmSlash(operationId: string, attemptId: string, userId: string, stakeAddress: string, mint: string) {
  const address = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(stakeAddress));
  const balance = await connection.getTokenAccountBalance(address, config.SOLANA_COMMITMENT);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evaluator-slash:${operationId}`]);
    await client.query(
      "UPDATE evaluator_slash_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId],
    );
    await client.query(
      "UPDATE evaluator_slash_operations SET state = 'confirmed', updated_at = now() WHERE id = $1", [operationId],
    );
    await client.query(
      `UPDATE evaluator_profiles SET stake_atomic = $2, active = ($2::numeric > 0), updated_at = now()
       WHERE user_id = $1`, [userId, balance.value.amount],
    );
    await client.query("COMMIT");
    return balance.value.amount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function slashOverturnedWarden(caseId: string) {
  const lock = `evaluator-slash-case:${caseId}`;
  const db = await pool.connect();
  let locked = false;
  let stakeLockHeld = false;
  let lockedEvaluatorUserId: string | undefined;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
    locked = true;
    const selected = await db.query<{
      case_id: string; stage: string; warden_verdict: string | null; panel_verdict: string | null; outcome: string | null;
      warden_user_id: string | null; commission_amount: string; client_wallet: string;
      provider_wallet: string | null; stake_wallet_public_key: string | null; stake_atomic: string | null;
      stake_mint: string | null; encrypted_secret_key: Buffer | null; encryption_nonce: Buffer | null;
      encryption_auth_tag: Buffer | null; encryption_key_version: number | null;
    }>(
      `SELECT tc.id AS case_id, tc.stage, tc.warden_verdict, tc.panel_verdict, tc.outcome, tc.warden_user_id,
              c.amount_atomic AS commission_amount, c.client_wallet, c.provider_wallet,
              e.stake_wallet_public_key, e.stake_atomic, e.stake_mint, e.encrypted_secret_key,
              e.encryption_nonce, e.encryption_auth_tag, e.encryption_key_version
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
         LEFT JOIN evaluator_profiles e ON e.user_id = tc.warden_user_id
        WHERE tc.id = $1 AND tc.stage = 'decided' AND tc.panel_decided_at IS NOT NULL`, [caseId],
    );
    const row = selected.rows[0];
    if (!row || !row.warden_user_id || !row.warden_verdict || !row.outcome) return { state: "not_due" as const };
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`evaluator-stake:${row.warden_user_id}`]);
    stakeLockHeld = true;
    lockedEvaluatorUserId = row.warden_user_id;
    if (effectiveVerdict(row.warden_verdict) === effectiveVerdict(row.outcome)) return { state: "not_overturned" as const };
    if (!row.stake_wallet_public_key || !row.stake_atomic || !row.stake_mint || !row.encrypted_secret_key
      || !row.encryption_nonce || !row.encryption_auth_tag || !row.encryption_key_version) {
      throw new ApiError(409, "warden_stake_missing", "The overturned Warden has no recoverable stake account.");
    }
    const destinations: Record<string, string> = {};
    const penalty = BigInt(row.commission_amount) < BigInt(row.stake_atomic)
      ? BigInt(row.commission_amount) : BigInt(row.stake_atomic);
    if (penalty <= 0n) throw new ApiError(409, "warden_stake_empty", "The overturned Warden has no stake left to slash.");
    if (effectiveVerdict(row.outcome) === "client") destinations[row.client_wallet] = penalty.toString();
    else if (effectiveVerdict(row.outcome) === "provider" && row.provider_wallet) destinations[row.provider_wallet] = penalty.toString();
    else if (row.outcome === "split" && row.provider_wallet) {
      const clientShare = penalty / 2n;
      destinations[row.client_wallet] = clientShare.toString();
      destinations[row.provider_wallet] = (penalty - clientShare).toString();
    } else throw new ApiError(409, "slash_destination_missing", "A party wallet is unavailable for the Warden slash.");

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO evaluator_slash_operations (case_id, evaluator_user_id, amount_atomic, distribution)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (case_id) DO NOTHING RETURNING id`,
      [caseId, row.warden_user_id, penalty.toString(), JSON.stringify(destinations)],
    );
    const operationResult = await db.query<{ id: string; state: string }>(
      "SELECT id, state FROM evaluator_slash_operations WHERE case_id = $1 FOR UPDATE", [caseId],
    );
    const operation = operationResult.rows[0];
    if (!operation) throw new Error("Could not create or load the evaluator slash operation.");
    if (operation.state === "confirmed") return { state: "confirmed" as const, amountAtomic: penalty.toString() };
    let attemptResult = await db.query<SlashAttempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM evaluator_slash_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
    );
    let attempt: SlashAttempt | undefined = attemptResult.rows[0];
    if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE evaluator_slash_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_slash_operations SET state = 'pending', failure_code = 'chain_error' WHERE id = $1", [operation.id]);
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        const amountAtomic = await confirmSlash(operation.id, attempt.id, row.warden_user_id, row.stake_wallet_public_key, row.stake_mint);
        return { state: "confirmed" as const, amountAtomic };
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE evaluator_slash_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_slash_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature, amountAtomic: penalty.toString() };
      } else {
        await db.query("UPDATE evaluator_slash_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE evaluator_slash_operations SET state = 'outcome_unknown', failure_code = 'chain_outcome_unknown', updated_at = now() WHERE id = $1", [operation.id]);
        throw new ApiError(409, "evaluator_slash_outcome_unknown", "The Warden slash expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
      }
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(row.stake_mint);
      const stakeWallet = new PublicKey(row.stake_wallet_public_key);
      const source = getAssociatedTokenAddressSync(mint, stakeWallet);
      const actualBalance = await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT);
      if (BigInt(actualBalance.value.amount) < penalty) throw new ApiError(409, "warden_stake_balance_low", "On-chain stake is lower than the required slash.");
      const decrypted = decryptSolanaSecretKey({
        ciphertext: row.encrypted_secret_key, nonce: row.encryption_nonce, authTag: row.encryption_auth_tag,
        keyVersion: row.encryption_key_version,
      });
      const stakeKeypair = Keypair.fromSecretKey(decrypted);
      if (!stakeKeypair.publicKey.equals(stakeWallet)) throw new Error("Decrypted evaluator stake key does not match its address.");
      const feePayer = loadSolanaFeePayer();
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest });
      for (const [destinationWallet, amount] of Object.entries(destinations)) {
        if (BigInt(amount) === 0n) continue;
        const owner = new PublicKey(destinationWallet);
        const tokenAccount = getAssociatedTokenAddressSync(mint, owner);
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, tokenAccount, owner, mint),
          createTransferCheckedInstruction(source, mint, tokenAccount, stakeWallet, BigInt(amount), 6, [], TOKEN_PROGRAM_ID),
        );
      }
      transaction.partialSign(feePayer, stakeKeypair);
      if (!transaction.signature) throw new Error("Signed evaluator slash transaction has no signature.");
      const signedTransaction = transaction.serialize();
      const signature = bs58.encode(transaction.signature);
      const saved = await db.query<{ id: string }>(
        `INSERT INTO evaluator_slash_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [operation.id, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: saved.rows[0].id, transaction_signature: signature, signed_transaction: signedTransaction,
        last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE evaluator_slash_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE evaluator_slash_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature, amountAtomic: penalty.toString() };
  } finally {
    if (stakeLockHeld && lockedEvaluatorUserId) {
      await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`evaluator-stake:${lockedEvaluatorUserId}`]).catch(() => undefined);
    }
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileOverturnedWardens(limit = 25) {
  const due = await pool.query<{ case_id: string }>(
    `SELECT tc.id AS case_id FROM tribunal_cases tc
      LEFT JOIN evaluator_slash_operations s ON s.case_id = tc.id
      WHERE tc.stage = 'decided' AND tc.panel_decided_at IS NOT NULL
        AND tc.warden_verdict IS NOT NULL AND tc.outcome IS NOT NULL
        AND (s.id IS NULL OR s.state <> 'confirmed')
      ORDER BY tc.panel_decided_at LIMIT $1`, [limit],
  );
  let submitted = 0;
  let confirmed = 0;
  const errors: { caseId: string; code: string }[] = [];
  for (const item of due.rows) {
    try {
      const result = await slashOverturnedWarden(item.case_id);
      if (result.state === "confirmed") confirmed += 1;
      else if (result.state === "submitted") submitted += 1;
    } catch (error) {
      errors.push({ caseId: item.case_id, code: error instanceof ApiError ? error.code : "slash_error" });
    }
  }
  return { examined: due.rows.length, submitted, confirmed, errors };
}
