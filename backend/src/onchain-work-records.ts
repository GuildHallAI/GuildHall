import { createHash } from "node:crypto";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { ApiError } from "./http.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
type ChainAttempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

/** Enqueue an immutable public digest in the same database transaction as its paid-work record. */
export async function enqueueWorkRecordChainOperation(db: PoolClient, workRecordId: string) {
  const result = await db.query<{
    id: string; commission_id: string; client_wallet: string; provider_wallet: string;
    asset_mint: string; amount_atomic: string; paid_amount_atomic: string; outcome: string; finalized_at: Date;
    worker_payouts: Array<{ wallet: string; amountAtomic: string }>;
  }>(
    `SELECT wr.id, wr.commission_id, client.wallet_address AS client_wallet,
            provider.wallet_address AS provider_wallet, wr.asset_mint, wr.amount_atomic::text,
            wr.paid_amount_atomic::text, wr.outcome, wr.finalized_at,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object('wallet', p.wallet_address, 'amountAtomic', p.amount_atomic::text)
                                ORDER BY p.wallet_address)
                 FROM work_record_payouts p WHERE p.work_record_id = wr.id),
              jsonb_build_array(jsonb_build_object('wallet', provider.wallet_address, 'amountAtomic', wr.paid_amount_atomic::text))
            ) AS worker_payouts
       FROM work_records wr JOIN wallet_users client ON client.id = wr.client_user_id
       JOIN wallet_users provider ON provider.id = wr.provider_user_id WHERE wr.id = $1`, [workRecordId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Cannot enqueue a missing work record.");
  const workerPayoutsHash = createHash("sha256").update(JSON.stringify(row.worker_payouts)).digest("hex");
  const publicRecord = {
    version: 1,
    workRecordId: row.id,
    commissionId: row.commission_id,
    clientWallet: row.client_wallet,
    providerWallet: row.provider_wallet,
    assetMint: row.asset_mint,
    amountAtomic: row.amount_atomic,
    paidAmountAtomic: row.paid_amount_atomic,
    workerCount: row.worker_payouts.length,
    workerPayoutsHash,
    outcome: row.outcome,
    finalizedAt: row.finalized_at.toISOString(),
  };
  const canonical = JSON.stringify(publicRecord);
  const recordHash = createHash("sha256").update(canonical).digest("hex");
  const memoData = JSON.stringify({ ...publicRecord, recordHash });
  if (Buffer.byteLength(memoData, "utf8") > 566) {
    throw new Error("The public work record exceeds the Solana Memo instruction data limit.");
  }
  await db.query(
    `INSERT INTO work_record_chain_operations (work_record_id, record_hash, memo_data)
     VALUES ($1, $2, $3) ON CONFLICT (work_record_id) DO NOTHING`, [workRecordId, recordHash, memoData],
  );
}

async function markConfirmed(operationId: string, attemptId: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE work_record_chain_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    await db.query("UPDATE work_record_chain_operations SET state = 'confirmed', updated_at = now() WHERE id = $1", [operationId]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function submitWorkRecordChainOperation(operationId: string) {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`work-record-chain:${operationId}`]);
    locked = true;
    const found = await db.query<{ state: string; transaction_signature: string | null; memo_data: string }>(
      "SELECT state, transaction_signature, memo_data FROM work_record_chain_operations WHERE id = $1", [operationId],
    );
    const operation = found.rows[0];
    if (!operation) throw new ApiError(404, "work_record_not_found", "On-chain work record operation not found.");
    if (operation.state === "confirmed") return { state: "confirmed" as const, signature: operation.transaction_signature };
    let rows = await db.query<ChainAttempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM work_record_chain_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operationId],
    );
    let attempt: ChainAttempt | undefined = rows.rows[0];
    if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE work_record_chain_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE work_record_chain_operations SET state = 'failed', updated_at = now() WHERE id = $1", [operationId]);
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await markConfirmed(operationId, attempt.id);
        return { state: "confirmed" as const, signature: attempt.transaction_signature };
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE work_record_chain_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE work_record_chain_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operationId, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature };
      } else {
        await db.query("UPDATE work_record_chain_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE work_record_chain_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [operationId]);
        throw new ApiError(409, "work_record_outcome_unknown", "The Memo transaction expired without a verifiable Solana result. The original transaction will be checked again before another record transaction is prepared.");
      }
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const payer = loadSolanaFeePayer();
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(operation.memo_data, "utf8") }),
      );
      transaction.partialSign(payer);
      if (!transaction.signature) throw new Error("Signed work record memo has no transaction signature.");
      const signature = bs58.encode(transaction.signature);
      const signed = transaction.serialize();
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO work_record_chain_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [operationId, signature, signed, latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: inserted.rows[0].id, transaction_signature: signature, signed_transaction: signed,
        last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE work_record_chain_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE work_record_chain_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operationId, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`work-record-chain:${operationId}`]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileWorkRecordChainOperations(limit = 25) {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM work_record_chain_operations WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown')
      ORDER BY created_at LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { operationId: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const result = await submitWorkRecordChainOperation(row.id);
      if (result.state === "confirmed") confirmed += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({ operationId: row.id, code: error instanceof ApiError ? error.code : "work_record_chain_error" });
    }
  }
  return { examined: due.rows.length, confirmed, submitted, errors };
}
