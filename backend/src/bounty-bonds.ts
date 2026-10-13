import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { Connection } from "@solana/web3.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { decryptSolanaSecretKey } from "./escrow-wallets.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { ApiError } from "./http.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
type Attempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

async function finishReturn(entryId: string, operationId: string, attemptId?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (attemptId) await client.query("UPDATE bounty_bond_operation_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    await client.query("UPDATE bounty_bond_operations SET state = 'confirmed', updated_at = now() WHERE id = $1", [operationId]);
    await client.query("UPDATE bounty_entries SET bond_returned_at = now() WHERE id = $1 AND bond_returned_at IS NULL", [entryId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function returnBountyEntryBond(entryId: string) {
  const db = await pool.connect();
  let lockHeld = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`bounty-bond:${entryId}`]);
    lockHeld = true;
    const found = await db.query<{
      commission_id: string; commission_status: string; asset_mint: string; wallet_address: string;
      bond_wallet_public_key: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
      encryption_auth_tag: Buffer; encryption_key_version: number; cluster: string; bond_returned_at: Date | null;
    }>(
      `SELECT e.commission_id, c.status AS commission_status, c.asset_mint, e.wallet_address,
              e.bond_wallet_public_key, e.encrypted_secret_key,
              e.bond_encryption_nonce AS encryption_nonce, e.bond_encryption_auth_tag AS encryption_auth_tag,
              e.bond_encryption_key_version AS encryption_key_version, e.cluster, e.bond_returned_at
         FROM bounty_entries e JOIN commissions c ON c.id = e.commission_id WHERE e.id = $1`, [entryId],
    );
    const entry = found.rows[0];
    if (!entry) throw new ApiError(404, "bounty_entry_not_found", "Bounty entry not found.");
    if (entry.cluster !== config.SOLANA_CLUSTER) throw new ApiError(409, "bounty_bond_cluster_mismatch", "The bounty bond EOA belongs to a different Solana cluster.");
    if (!["complete", "refunded"].includes(entry.commission_status)) return { state: "waiting" as const };
    if (entry.bond_returned_at) return { state: "confirmed" as const };
    const operationResult = await db.query<{ id: string; state: string; transaction_signature: string | null }>(
      `INSERT INTO bounty_bond_operations (entry_id, amount_atomic)
       VALUES ($1, 0) ON CONFLICT (entry_id) DO UPDATE SET updated_at = bounty_bond_operations.updated_at
       RETURNING id, state, transaction_signature`, [entryId],
    );
    const operation = operationResult.rows[0];
    if (!operation) throw new Error("Could not create bounty bond return operation.");
    if (["confirmed", "empty"].includes(operation.state)) return { state: operation.state as "confirmed" | "empty", signature: operation.transaction_signature };
    let attemptResult = await db.query<Attempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM bounty_bond_operation_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
    );
    let attempt: Attempt | undefined = attemptResult.rows[0];
    if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE bounty_bond_operation_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE bounty_bond_operations SET state = 'failed', updated_at = now() WHERE id = $1", [operation.id]);
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await finishReturn(entryId, operation.id, attempt.id);
        return { state: "confirmed" as const, signature: attempt.transaction_signature };
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE bounty_bond_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE bounty_bond_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature };
      } else {
        await db.query("UPDATE bounty_bond_operation_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE bounty_bond_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [operation.id]);
        throw new ApiError(409, "bounty_bond_return_outcome_unknown", "The bond return expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
      }
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(entry.asset_mint);
      const bondWallet = new PublicKey(entry.bond_wallet_public_key);
      const recipient = new PublicKey(entry.wallet_address);
      const source = getAssociatedTokenAddressSync(mint, bondWallet);
      const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
      if (!sourceInfo) {
        await db.query("UPDATE bounty_bond_operations SET state = 'empty', amount_atomic = 0, updated_at = now() WHERE id = $1", [operation.id]);
        await db.query("UPDATE bounty_entries SET bond_returned_at = now() WHERE id = $1 AND bond_returned_at IS NULL", [entryId]);
        return { state: "empty" as const };
      }
      const amount = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
      const feePayer = loadSolanaFeePayer();
      const key = Keypair.fromSecretKey(decryptSolanaSecretKey({ ciphertext: entry.encrypted_secret_key,
        nonce: entry.encryption_nonce, authTag: entry.encryption_auth_tag, keyVersion: entry.encryption_key_version }));
      if (!key.publicKey.equals(bondWallet)) throw new Error("Bounty bond EOA key does not match its recorded address.");
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest });
      if (amount > 0n) transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, bondWallet, amount, 6, [], TOKEN_PROGRAM_ID),
      );
      transaction.add(createCloseAccountInstruction(source, recipient, bondWallet, [], TOKEN_PROGRAM_ID));
      transaction.partialSign(feePayer, key);
      if (!transaction.signature) throw new Error("Signed bounty bond return has no signature.");
      const signature = bs58.encode(transaction.signature);
      const saved = await db.query<{ id: string }>(
        `INSERT INTO bounty_bond_operation_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [operation.id, signature, transaction.serialize(), latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: saved.rows[0].id, transaction_signature: signature,
        signed_transaction: transaction.serialize(), last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
      await db.query("UPDATE bounty_bond_operations SET amount_atomic = $2, state = 'pending', updated_at = now() WHERE id = $1", [operation.id, amount.toString()]);
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE bounty_bond_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE bounty_bond_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature };
  } finally {
    if (lockHeld) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`bounty-bond:${entryId}`]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileBountyBondReturns(limit = 25) {
  const rows = await pool.query<{ id: string }>(
    `SELECT e.id FROM bounty_entries e JOIN commissions c ON c.id = e.commission_id
      LEFT JOIN bounty_bond_operations o ON o.entry_id = e.id
     WHERE c.status IN ('complete', 'refunded') AND e.bond_returned_at IS NULL
       AND (o.id IS NULL OR o.state IN ('pending', 'submitted', 'failed', 'outcome_unknown'))
     ORDER BY e.created_at LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { entryId: string; code: string }[] = [];
  for (const row of rows.rows) {
    try {
      const result = await returnBountyEntryBond(row.id);
      if (result.state === "confirmed" || result.state === "empty") confirmed += 1;
      else if (result.state === "submitted") submitted += 1;
    } catch (error) {
      errors.push({ entryId: row.id, code: error instanceof ApiError ? error.code : "bond_return_error" });
    }
  }
  return { examined: rows.rows.length, confirmed, submitted, errors };
}
