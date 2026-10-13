import { Keypair, PublicKey, Transaction, Connection } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { decryptSolanaSecretKey } from "./escrow-wallets.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { ApiError } from "./http.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

type AgentTransfer = { mint: string; amountAtomic: string; destinationWallet: string };
type AgentAccount = {
  id: string; public_key: string; owner_user_id: string; owner_wallet: string;
  max_action_atomic: string; daily_budget_atomic: string;
  allowed_mints: string[]; allowed_programs: string[]; expires_at: Date; disabled_at: Date | null;
  encrypted_secret_key: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer; encryption_key_version: number;
};
type AgentOperation = {
  id: string; mint: string; amount_atomic: string; destination_wallet: string; usage_date: string;
  state: string; transaction_signature: string | null; operation_kind: "transfer" | "recovery";
  budget_reserved: boolean;
};
type AgentAttempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

async function buildAttempt(db: PoolClient, account: AgentAccount, operation: AgentOperation) {
  const mint = new PublicKey(operation.mint);
  const agentWallet = new PublicKey(account.public_key);
  const destinationWallet = new PublicKey(operation.destination_wallet);
  const source = getAssociatedTokenAddressSync(mint, agentWallet);
  const destination = getAssociatedTokenAddressSync(mint, destinationWallet);
  const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
  if (!sourceInfo) throw new ApiError(409, "agent_balance_low", "The agent account has no token account for this asset.");
  const balance = await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT);
  if (balance.value.decimals !== 6) throw new ApiError(422, "asset_decimals_mismatch", "Only six-decimal stablecoin token accounts are supported.");
  if (BigInt(balance.value.amount) < BigInt(operation.amount_atomic)) {
    throw new ApiError(409, "agent_balance_low", "The agent account does not hold enough tokens for this action.");
  }
  const payer = loadSolanaFeePayer();
  const secret = decryptSolanaSecretKey({ ciphertext: account.encrypted_secret_key,
    nonce: account.encryption_nonce, authTag: account.encryption_auth_tag,
    keyVersion: account.encryption_key_version });
  const agentKey = Keypair.fromSecretKey(secret);
  if (!agentKey.publicKey.equals(agentWallet)) throw new Error("Agent private key does not match its recorded public key.");
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, destinationWallet, mint),
    createTransferCheckedInstruction(source, mint, destination, agentWallet, BigInt(operation.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
  );
  transaction.partialSign(payer, agentKey);
  if (!transaction.signature) throw new Error("Signed agent transfer has no signature.");
  const signature = bs58.encode(transaction.signature);
  const signedTransaction = transaction.serialize();
  const saved = await db.query<{ id: string }>(
    `INSERT INTO agent_transfer_attempts
       (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
     VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
    [operation.id, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
  );
  return {
    id: saved.rows[0].id,
    transaction_signature: signature,
    signed_transaction: signedTransaction,
    last_valid_block_height: String(latest.lastValidBlockHeight),
    state: "prepared" as const,
  };
}

async function finishAgentOperation(accountId: string, operation: AgentOperation, attempt: AgentAttempt, state: "confirmed" | "failed") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM agent_accounts WHERE id = $1 FOR UPDATE", [accountId]);
    await db.query("UPDATE agent_transfer_attempts SET state = $2, updated_at = now() WHERE id = $1", [attempt.id, state]);
    await db.query(
      `UPDATE agent_transfer_operations SET state = $2, updated_at = now(),
         transaction_signature = $3, failure_code = CASE WHEN $2 = 'failed' THEN 'chain_error' ELSE NULL END
       WHERE id = $1`, [operation.id, state, attempt.transaction_signature],
    );
    if (state === "failed" && operation.budget_reserved) {
      await db.query(
        `UPDATE agent_daily_spend SET spent_atomic = GREATEST(spent_atomic - $3::numeric, 0), updated_at = now()
          WHERE account_id = (SELECT account_id FROM agent_transfer_operations WHERE id = $1) AND usage_date = $2`,
        [operation.id, operation.usage_date, operation.amount_atomic],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function submitAgentTransfer(accountId: string, idempotencyKey: string, input?: AgentTransfer, recovery = false) {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`agent-account:${accountId}`]);
    locked = true;
    const accountResult = await db.query<AgentAccount>(
      `SELECT a.*, u.wallet_address AS owner_wallet FROM agent_accounts a
        JOIN wallet_users u ON u.id = a.owner_user_id WHERE a.id = $1`, [accountId],
    );
    const account = accountResult.rows[0];
    if (!account) throw new ApiError(404, "agent_account_not_found", "Agent account not found.");
    const operationResult = await db.query<AgentOperation>(
      `SELECT id, mint, amount_atomic, destination_wallet, usage_date::text, state, transaction_signature,
              operation_kind, budget_reserved
         FROM agent_transfer_operations WHERE account_id = $1 AND idempotency_key = $2`, [accountId, idempotencyKey],
    );
    let operation: AgentOperation | undefined = operationResult.rows[0];
    if (!operation) {
      if (!input) throw new ApiError(404, "agent_operation_not_found", "Agent transfer operation not found.");
      const unknown = await db.query(
        "SELECT 1 FROM agent_transfer_operations WHERE account_id = $1 AND state = 'outcome_unknown' LIMIT 1", [accountId],
      );
      if (unknown.rowCount) throw new ApiError(409, "agent_transfer_reconciliation_required", "Resolve the agent account's earlier transfer before preparing another transfer.");
      if (!recovery && (account.disabled_at || account.expires_at <= new Date())) throw new ApiError(409, "agent_account_inactive", "This agent account is disabled or expired.");
      if (recovery && input.destinationWallet !== account.owner_wallet) throw new ApiError(403, "recovery_destination_invalid", "Agent account recovery can send funds only to the owner's wallet.");
      if (!account.allowed_mints.includes(input.mint)) throw new ApiError(403, "asset_not_allowed", "This asset is not allowed for the agent account.");
      if (!account.allowed_programs.includes(TOKEN_PROGRAM_ID.toBase58())
        || !account.allowed_programs.includes(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())) {
        throw new ApiError(403, "program_not_allowed", "The agent account has not authorized the programs required for this SPL transfer.");
      }
      const amount = BigInt(input.amountAtomic);
      if (!recovery && amount > BigInt(account.max_action_atomic)) throw new ApiError(409, "action_limit_exceeded", "This action exceeds the agent account's per-action limit.");
      await db.query("BEGIN");
      try {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-account:${accountId}`]);
        const lockedAccount = await db.query<AgentAccount>(
          `SELECT a.*, u.wallet_address AS owner_wallet FROM agent_accounts a
            JOIN wallet_users u ON u.id = a.owner_user_id WHERE a.id = $1 FOR UPDATE OF a`, [accountId],
        );
        const current = lockedAccount.rows[0];
        if (!current || (!recovery && (current.disabled_at || current.expires_at <= new Date()))) throw new ApiError(409, "agent_account_inactive", "This agent account is disabled or expired.");
        if (recovery && input.destinationWallet !== current.owner_wallet) throw new ApiError(403, "recovery_destination_invalid", "Agent account recovery can send funds only to the owner's wallet.");
        if (!current.allowed_mints.includes(input.mint)) throw new ApiError(403, "asset_not_allowed", "This asset is not allowed for the agent account.");
        if (!recovery && amount > BigInt(current.max_action_atomic)) throw new ApiError(409, "action_limit_exceeded", "This action exceeds the agent account's per-action limit.");
        let usageDate: string;
        if (recovery) {
          usageDate = (await db.query<{ usage_date: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS usage_date")).rows[0].usage_date;
        } else {
          await db.query(
            "INSERT INTO agent_daily_spend (account_id, usage_date, spent_atomic) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 0) ON CONFLICT DO NOTHING",
            [accountId],
          );
          const usage = await db.query<{ usage_date: string; spent_atomic: string }>(
            "SELECT usage_date::text, spent_atomic FROM agent_daily_spend WHERE account_id = $1 AND usage_date = (now() AT TIME ZONE 'UTC')::date FOR UPDATE",
            [accountId],
          );
          if (BigInt(usage.rows[0].spent_atomic) + amount > BigInt(current.daily_budget_atomic)) {
            throw new ApiError(409, "daily_budget_exceeded", "This transfer would exceed the agent account's daily budget.");
          }
          usageDate = usage.rows[0].usage_date;
          await db.query(
            "UPDATE agent_daily_spend SET spent_atomic = spent_atomic + $3::numeric, updated_at = now() WHERE account_id = $1 AND usage_date = $2::date",
            [accountId, usageDate, amount.toString()],
          );
        }
        const created = await db.query<AgentOperation>(
          `INSERT INTO agent_transfer_operations
             (account_id, idempotency_key, operation_kind, mint, amount_atomic, destination_wallet, usage_date, budget_reserved)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
           RETURNING id, mint, amount_atomic, destination_wallet, usage_date::text, state, transaction_signature, operation_kind, budget_reserved`,
          [accountId, idempotencyKey, recovery ? "recovery" : "transfer", input.mint, input.amountAtomic,
            input.destinationWallet, usageDate, !recovery],
        );
        operation = created.rows[0];
        const attempt = await buildAttempt(db, current, operation);
        await db.query("COMMIT");
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE agent_transfer_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE agent_transfer_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1",
          [operation.id, attempt.transaction_signature]);
        return { id: operation.id, state: "submitted" as const, signature: attempt.transaction_signature,
          mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
      } catch (error) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    if (recovery !== (operation.operation_kind === "recovery")) {
      throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key belongs to a different operation type.");
    }
    if (input && (input.mint !== operation.mint || input.amountAtomic !== operation.amount_atomic
      || input.destinationWallet !== operation.destination_wallet)) {
      throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different transfer.");
    }
    const isRecovery = operation.operation_kind === "recovery";
    if (operation.state === "confirmed") return { id: operation.id, state: "confirmed" as const,
      signature: operation.transaction_signature, mint: operation.mint,
      amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet, idempotentReplay: true };
    if (operation.state === "failed") throw new ApiError(409, "agent_transfer_failed", "This idempotent transfer failed on Solana; use a new key to retry it.");
    const attempts = await db.query<AgentAttempt>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM agent_transfer_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
    );
    let attempt: AgentAttempt | undefined = attempts.rows[0];
    if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await finishAgentOperation(accountId, operation, attempt, "failed");
        throw new ApiError(422, "agent_transfer_failed", "The transfer transaction failed on Solana.");
      }
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await finishAgentOperation(accountId, operation, attempt, "confirmed");
        return { id: operation.id, state: "confirmed" as const, signature: attempt.transaction_signature,
          mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
      }
      const blockHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
      if (blockHeight <= Number(attempt.last_valid_block_height)) {
        if (!isRecovery && (account.disabled_at || account.expires_at <= new Date())) {
          return { id: operation.id, state: "paused" as const, signature: attempt.transaction_signature,
            mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
        }
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE agent_transfer_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE agent_transfer_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1",
          [operation.id, attempt.transaction_signature]);
        return { id: operation.id, state: "submitted" as const, signature: attempt.transaction_signature,
          mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
      }
      await db.query("UPDATE agent_transfer_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
      await db.query("UPDATE agent_transfer_operations SET state = 'outcome_unknown', failure_code = 'chain_outcome_unknown', updated_at = now() WHERE id = $1", [operation.id]);
      throw new ApiError(409, "agent_transfer_outcome_unknown", "The agent transfer expired without a verifiable Solana result. The reserved budget remains held while the original transaction is checked again.");
    }
    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      if (!isRecovery && (account.disabled_at || account.expires_at <= new Date())) throw new ApiError(409, "agent_account_inactive", "This agent account is disabled or expired.");
      const replacement = await buildAttempt(db, account, operation);
      await connection.sendRawTransaction(replacement.signed_transaction, { maxRetries: 3, skipPreflight: false });
      await db.query("UPDATE agent_transfer_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [replacement.id]);
      await db.query("UPDATE agent_transfer_operations SET state = 'submitted', transaction_signature = $2, failure_code = NULL, updated_at = now() WHERE id = $1",
        [operation.id, replacement.transaction_signature]);
      return { id: operation.id, state: "submitted" as const, signature: replacement.transaction_signature,
        mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
    }
    return { id: operation.id, state: "submitted" as const, signature: attempt.transaction_signature,
      mint: operation.mint, amountAtomic: operation.amount_atomic, destinationWallet: operation.destination_wallet };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`agent-account:${accountId}`]).catch(() => undefined);
    db.release();
  }
}

export async function reconcileAgentTransfers(limit = 25) {
  const due = await pool.query<{ account_id: string; idempotency_key: string; operation_kind: "transfer" | "recovery" }>(
    "SELECT account_id, idempotency_key, operation_kind FROM agent_transfer_operations WHERE state IN ('pending', 'submitted', 'outcome_unknown') ORDER BY updated_at LIMIT $1",
    [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  let paused = 0;
  const errors: { operationKey: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const result = await submitAgentTransfer(row.account_id, row.idempotency_key, undefined, row.operation_kind === "recovery");
      if (result.state === "confirmed") confirmed += 1;
      else if (result.state === "paused") paused += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({ operationKey: row.idempotency_key, code: error instanceof ApiError ? error.code : "agent_transfer_error" });
    }
  }
  return { examined: due.rows.length, confirmed, submitted, paused, errors };
}
