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
type Attempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

async function markConfirmed(returnId: string, attemptId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE guild_bond_return_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    await client.query("UPDATE guild_bond_returns SET state = 'confirmed', updated_at = now() WHERE id = $1", [returnId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function submitGuildBondReturn(returnId: string) {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`guild-bond-return:${returnId}`]);
    locked = true;
    const result = await db.query<{
      guild_id: string; amount_atomic: string; state: string; transaction_signature: string | null;
      depositor_wallet: string; bond_mint: string; bond_wallet_public_key: string;
      encrypted_secret_key: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer; encryption_key_version: number;
      cluster: string; status: string;
    }>(
      `SELECT r.guild_id, r.amount_atomic, r.state, r.transaction_signature, d.depositor_wallet,
              g.bond_mint, g.bond_wallet_public_key, g.encrypted_secret_key, g.encryption_nonce,
              g.encryption_auth_tag, g.encryption_key_version, g.cluster, g.status
         FROM guild_bond_returns r JOIN guild_bond_deposits d ON d.id = r.deposit_id
         JOIN guilds g ON g.id = r.guild_id WHERE r.id = $1`, [returnId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "guild_bond_return_not_found", "Guild bond return not found.");
    if (row.cluster !== config.SOLANA_CLUSTER) throw new ApiError(409, "guild_bond_cluster_mismatch", "The Guild bond EOA belongs to another Solana cluster.");
    if (row.status !== "closed") throw new ApiError(409, "guild_not_closed", "Guild bonds can be returned only after the Guild is closed.");
    if (row.state === "confirmed") return { state: "confirmed" as const, signature: row.transaction_signature };

    const latestAttempt = await db.query<Attempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM guild_bond_return_attempts WHERE return_id = $1 ORDER BY created_at DESC LIMIT 1`, [returnId],
    );
    let attempt: Attempt | undefined = latestAttempt.rows[0];
    if (row.state === "outcome_unknown") {
      if (!attempt) throw new ApiError(409, "guild_bond_return_outcome_unknown", "The Guild bond return outcome is unknown and must be reconciled before another transfer is prepared.");
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await markConfirmed(returnId, attempt.id);
        return { state: "confirmed" as const, signature: attempt.transaction_signature };
      }
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE guild_bond_return_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE guild_bond_returns SET state = 'failed', updated_at = now() WHERE id = $1", [returnId]);
        attempt = undefined;
      } else {
        throw new ApiError(409, "guild_bond_return_outcome_unknown", "The Guild bond return outcome remains unknown; no replacement transfer will be prepared.");
      }
    }
    if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE guild_bond_return_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE guild_bond_returns SET state = 'failed', updated_at = now() WHERE id = $1", [returnId]);
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await markConfirmed(returnId, attempt.id);
        return { state: "confirmed" as const, signature: attempt.transaction_signature };
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE guild_bond_return_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE guild_bond_returns SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [returnId, attempt.transaction_signature]);
        return { state: "submitted" as const, signature: attempt.transaction_signature };
      } else {
        await db.query("UPDATE guild_bond_return_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE guild_bond_returns SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [returnId]);
        throw new ApiError(409, "guild_bond_return_outcome_unknown", "The Guild bond return expired but its Solana outcome could not be verified. No replacement transfer was prepared.");
      }
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(row.bond_mint);
      const vault = new PublicKey(row.bond_wallet_public_key);
      const recipient = new PublicKey(row.depositor_wallet);
      const source = getAssociatedTokenAddressSync(mint, vault);
      const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
      const balance = sourceInfo ? BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount) : 0n;
      if (balance < BigInt(row.amount_atomic)) throw new ApiError(409, "guild_bond_balance_low", "The Guild bond account does not hold enough USDC to return this deposit.");
      const feePayer = loadSolanaFeePayer();
      const secret = decryptSolanaSecretKey({ ciphertext: row.encrypted_secret_key, nonce: row.encryption_nonce,
        authTag: row.encryption_auth_tag, keyVersion: row.encryption_key_version });
      const vaultKey = Keypair.fromSecretKey(secret);
      if (!vaultKey.publicKey.equals(vault)) throw new Error("Guild bond EOA key does not match its recorded address.");
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest }).add(
        createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, vault, BigInt(row.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
      );
      transaction.partialSign(feePayer, vaultKey);
      if (!transaction.signature) throw new Error("Signed Guild bond return has no signature.");
      const signature = bs58.encode(transaction.signature);
      const signedTransaction = transaction.serialize();
      const saved = await db.query<{ id: string }>(
        `INSERT INTO guild_bond_return_attempts
           (return_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [returnId, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
      );
      attempt = { id: saved.rows[0].id, transaction_signature: signature, signed_transaction: signedTransaction,
        last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
    }
    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE guild_bond_return_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query("UPDATE guild_bond_returns SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [returnId, attempt.transaction_signature]);
    return { state: "submitted" as const, signature: attempt.transaction_signature };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`guild-bond-return:${returnId}`]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileGuildBondReturns(limit = 25) {
  const due = await pool.query<{ id: string }>(
    `SELECT r.id FROM guild_bond_returns r JOIN guilds g ON g.id = r.guild_id
      WHERE g.status = 'closed' AND r.state IN ('pending', 'submitted', 'failed', 'outcome_unknown')
      ORDER BY r.created_at LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { returnId: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const result = await submitGuildBondReturn(row.id);
      if (result.state === "confirmed") confirmed += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({ returnId: row.id, code: error instanceof ApiError ? error.code : "guild_bond_return_error" });
    }
  }
  return { examined: due.rows.length, confirmed, submitted, errors };
}
