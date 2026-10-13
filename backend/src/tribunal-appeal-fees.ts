import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { createEncryptedSolanaWallet, decryptSolanaSecretKey } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";
import { ghallBalanceAtomic } from "./ghall.js";
import { tokenOwnerBalanceDelta } from "./solana-token-balance.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

export async function prepareTribunalAppealFee(input: {
  caseId: string; tier: "warden" | "panel"; userId: string; walletAddress: string; appealedVerdict: string;
}) {
  if (config.TRIBUNAL_APPEAL_FEE_ATOMIC > 0n && !config.USDC_MINT) {
    throw new ApiError(503, "appeal_fee_unavailable", "USDC is not configured for Tribunal appeal fees.");
  }
  const baseFee = config.TRIBUNAL_APPEAL_FEE_ATOMIC;
  let discountBps = 0;
  if (baseFee > 0n && config.GHALL_TRIBUNAL_FEE_DISCOUNT_BPS > 0
    && config.GHALL_TRIBUNAL_FEE_DISCOUNT_THRESHOLD_ATOMIC > 0n
    && await ghallBalanceAtomic(input.walletAddress) >= config.GHALL_TRIBUNAL_FEE_DISCOUNT_THRESHOLD_ATOMIC) {
    discountBps = config.GHALL_TRIBUNAL_FEE_DISCOUNT_BPS;
  }
  const charged = baseFee - baseFee * BigInt(discountBps) / 10_000n;
  const client = await pool.connect();
  let feeId: string;
  let feeWallet: string;
  let status: string;
  let existingSignature: string | null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal-fee:${input.caseId}:${input.tier}`]);
    let record = (await client.query<{
      id: string; appellant_user_id: string; fee_wallet_public_key: string; state: string; payment_signature: string | null;
    }>(
      `SELECT id, appellant_user_id, fee_wallet_public_key, state, payment_signature
         FROM tribunal_appeal_fees WHERE case_id = $1 AND appeal_tier = $2 FOR UPDATE`, [input.caseId, input.tier],
    )).rows[0];
    if (record && record.appellant_user_id !== input.userId) {
      throw new ApiError(409, "appeal_fee_already_reserved", "The appeal fee instructions were already created by the other commission participant.");
    }
    if (!record) {
      const wallet = createEncryptedSolanaWallet();
      const inserted = await client.query<{ id: string; fee_wallet_public_key: string; state: string; payment_signature: string | null }>(
        `INSERT INTO tribunal_appeal_fees
           (case_id, appeal_tier, appellant_user_id, fee_wallet_public_key, encrypted_secret_key,
            encryption_nonce, encryption_auth_tag, encryption_key_version, cluster, mint,
            base_fee_atomic, discount_bps, charged_fee_atomic, appealed_verdict, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id, fee_wallet_public_key, state, payment_signature`,
        [input.caseId, input.tier, input.userId, wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce,
          wallet.encryptionAuthTag, wallet.encryptionKeyVersion, config.SOLANA_CLUSTER, config.USDC_MINT ?? "unconfigured",
          baseFee.toString(), discountBps, charged.toString(), input.appealedVerdict, charged === 0n ? "waived" : "awaiting_payment"],
      );
      record = { ...inserted.rows[0], appellant_user_id: input.userId };
    }
    await client.query("COMMIT");
    feeId = record.id;
    feeWallet = record.fee_wallet_public_key;
    status = record.state;
    existingSignature = record.payment_signature;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }

  const stored = await pool.query<{ base_fee_atomic: string; discount_bps: number; charged_fee_atomic: string; mint: string }>(
    "SELECT base_fee_atomic::text, discount_bps, charged_fee_atomic::text, mint FROM tribunal_appeal_fees WHERE id = $1", [feeId!],
  );
  const row = stored.rows[0]!;
  if (status !== "awaiting_payment") {
    return { feeId: feeId!, state: status, paymentSignature: existingSignature, baseFeeAtomic: row.base_fee_atomic,
      discountBasisPoints: row.discount_bps, chargedFeeAtomic: row.charged_fee_atomic, unsignedTransaction: null };
  }
  const mint = new PublicKey(row.mint);
  const wallet = new PublicKey(input.walletAddress);
  const escrow = new PublicKey(feeWallet!);
  const source = getAssociatedTokenAddressSync(mint, wallet);
  const destination = getAssociatedTokenAddressSync(mint, escrow);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: wallet, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, mint),
    createAssociatedTokenAccountIdempotentInstruction(wallet, destination, escrow, mint),
    createTransferCheckedInstruction(source, mint, destination, wallet, BigInt(row.charged_fee_atomic), 6, [], TOKEN_PROGRAM_ID),
  );
  return { feeId: feeId!, state: status, feeWallet: feeWallet!, mint: row.mint,
    baseFeeAtomic: row.base_fee_atomic, discountBasisPoints: row.discount_bps,
    chargedFeeAtomic: row.charged_fee_atomic,
    unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight: latest.lastValidBlockHeight };
}

export async function confirmTribunalAppealFee(caseId: string, tier: "warden" | "panel", userId: string, signature?: string) {
  if (config.TRIBUNAL_APPEAL_FEE_ATOMIC === 0n) return;
  const record = await pool.query<{
    id: string; appellant_user_id: string; fee_wallet_public_key: string; mint: string;
    charged_fee_atomic: string; payment_signature: string | null; state: string;
  }>(
    `SELECT id, appellant_user_id, fee_wallet_public_key, mint, charged_fee_atomic::text,
            payment_signature, state FROM tribunal_appeal_fees WHERE case_id = $1 AND appeal_tier = $2`, [caseId, tier],
  );
  const fee = record.rows[0];
  if (!fee || fee.appellant_user_id !== userId) {
    throw new ApiError(409, "appeal_fee_instructions_required", "Create appeal fee instructions for this wallet before submitting the appeal.");
  }
  if (fee.state === "waived") return;
  if (fee.state === "paid" && (!signature || fee.payment_signature === signature)) return;
  if (fee.state === "paid") throw new ApiError(409, "appeal_fee_already_paid", "This appeal fee was paid with a different transaction.");
  if (!signature) throw new ApiError(402, "appeal_fee_required", "Prepare and confirm the Tribunal appeal fee before submitting an appeal.");
  let signatureBytes: Uint8Array;
  try { signatureBytes = bs58.decode(signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (signatureBytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  if (fee.state !== "awaiting_payment") throw new ApiError(409, "appeal_fee_already_paid", "The appeal fee is already paid or being settled.");
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "appeal_fee_unconfirmed", "The appeal fee payment is not confirmed on this cluster.");
  }
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "appeal_fee_transaction_unavailable", "The confirmed appeal payment details are not available yet.");
  const user = await pool.query<{ wallet_address: string }>("SELECT wallet_address FROM wallet_users WHERE id = $1", [userId]);
  const wallet = user.rows[0]?.wallet_address;
  if (!wallet || !parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer)) {
    throw new ApiError(422, "appeal_fee_signer_mismatch", "The appellant wallet did not authorize this payment.");
  }
  const postBalances = parsed.meta.postTokenBalances ?? [];
  const destination = postBalances.find((balance) => balance.mint === fee.mint && balance.owner === fee.fee_wallet_public_key);
  if (!destination || destination.uiTokenAmount.decimals !== 6) {
    throw new ApiError(422, "appeal_fee_destination_mismatch", "The payment did not fund the appeal fee EOA in USDC.");
  }
  const before = (parsed.meta.preTokenBalances ?? []).find((balance) => balance.accountIndex === destination.accountIndex && balance.mint === fee.mint);
  const received = BigInt(destination.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
  const sourceDelta = tokenOwnerBalanceDelta(parsed.meta.preTokenBalances ?? [], postBalances, fee.mint, wallet);
  if (received !== BigInt(fee.charged_fee_atomic) || sourceDelta !== -received) {
    throw new ApiError(422, "appeal_fee_amount_mismatch", "The appellant must transfer the exact discounted USDC appeal fee to the fee EOA.");
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal-fee:${caseId}:${tier}`]);
    const current = await db.query<{ state: string; payment_signature: string | null }>(
      "SELECT state, payment_signature FROM tribunal_appeal_fees WHERE id = $1 FOR UPDATE", [fee.id],
    );
    if (current.rows[0]?.state === "paid" && current.rows[0].payment_signature === signature) {
      await db.query("COMMIT");
      return;
    }
    if (current.rows[0]?.state !== "awaiting_payment") {
      throw new ApiError(409, "appeal_fee_already_paid", "The appeal fee was already confirmed with a different transaction.");
    }
    const duplicate = await db.query("SELECT 1 FROM tribunal_appeal_fees WHERE payment_signature = $1 AND id <> $2", [signature, fee.id]);
    if (duplicate.rowCount) throw new ApiError(409, "appeal_fee_signature_used", "This payment transaction was already used for another appeal fee.");
    await db.query(
      `UPDATE tribunal_appeal_fees SET payment_signature = $2, state = 'paid', updated_at = now()
        WHERE id = $1 AND state = 'awaiting_payment'`, [fee.id, signature],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function markTribunalAppealSubmitted(
  client: import("pg").PoolClient, caseId: string, tier: "warden" | "panel", userId: string,
) {
  if (config.TRIBUNAL_APPEAL_FEE_ATOMIC === 0n) return;
  const fee = await client.query<{ id: string; state: string; appellant_user_id: string }>(
    "SELECT id, state, appellant_user_id FROM tribunal_appeal_fees WHERE case_id = $1 AND appeal_tier = $2 FOR UPDATE",
    [caseId, tier],
  );
  const row = fee.rows[0];
  if (!row || row.appellant_user_id !== userId) {
    throw new ApiError(409, "appeal_fee_instructions_required", "Create and confirm the appeal fee before submitting the appeal.");
  }
  if (row.state === "waived" || row.state === "appealed") return;
  if (row.state !== "paid") throw new ApiError(409, "appeal_fee_required", "The confirmed appeal fee is not available for this appeal.");
  await client.query("UPDATE tribunal_appeal_fees SET state = 'appealed', updated_at = now() WHERE id = $1", [row.id]);
}

const normalizedVerdict = (verdict: string | null) => verdict === "dismissed" ? "provider" : verdict;

export async function queueTribunalAppealFeeSettlements(
  client: import("pg").PoolClient,
  caseId: string,
  outcome: string,
  wardenVerdict: string | null,
  panelVerdict: string | null,
) {
  const fees = await client.query<{
    id: string; appeal_tier: "warden" | "panel"; appellant_user_id: string; charged_fee_atomic: string;
  }>(
    `SELECT id, appeal_tier, appellant_user_id, charged_fee_atomic::text FROM tribunal_appeal_fees
      WHERE case_id = $1 AND state = 'appealed' FOR UPDATE`, [caseId],
  );
  for (const fee of fees.rows) {
    const appealedVerdict = fee.appeal_tier === "warden" ? wardenVerdict : panelVerdict;
    const won = Boolean(appealedVerdict && normalizedVerdict(outcome) !== normalizedVerdict(appealedVerdict));
    const operation = won ? "refund" : "treasury";
    let destination: string | null;
    if (won) {
      const wallet = await client.query<{ wallet_address: string }>("SELECT wallet_address FROM wallet_users WHERE id = $1", [fee.appellant_user_id]);
      destination = wallet.rows[0]?.wallet_address ?? null;
    } else destination = config.TREASURY_WALLET ?? null;
    const nextState = won ? "refund_pending" : "treasury_pending";
    await client.query("UPDATE tribunal_appeal_fees SET won = $2, state = $3, updated_at = now() WHERE id = $1", [fee.id, won, nextState]);
    if (destination) {
      await client.query(
        `INSERT INTO tribunal_appeal_fee_operations (fee_id, operation, amount_atomic, destination_wallet)
         VALUES ($1, $2, $3, $4) ON CONFLICT (fee_id) DO NOTHING`, [fee.id, operation, fee.charged_fee_atomic, destination],
      );
    }
  }
}

export async function reconcileTribunalAppealFees(limit = 25) {
  await pool.query(
    `UPDATE tribunal_appeal_fees f SET won = true, state = 'refund_pending', updated_at = now()
       FROM tribunal_cases tc
      WHERE tc.id = f.case_id AND f.state = 'paid'
        AND (tc.stage = 'decided'
          OR (f.appeal_tier = 'warden' AND tc.stage = 'warden' AND tc.appeal_deadline_at <= now())
          OR (f.appeal_tier = 'panel' AND tc.stage = 'panel' AND tc.appeal_deadline_at <= now()))`,
  );
  await pool.query(
    `INSERT INTO tribunal_appeal_fee_operations (fee_id, operation, amount_atomic, destination_wallet)
     SELECT f.id, 'refund', f.charged_fee_atomic, u.wallet_address
       FROM tribunal_appeal_fees f JOIN wallet_users u ON u.id = f.appellant_user_id
      WHERE f.state = 'refund_pending' AND NOT EXISTS
        (SELECT 1 FROM tribunal_appeal_fee_operations o WHERE o.fee_id = f.id)
     ON CONFLICT (fee_id) DO NOTHING`,
  );
  if (config.TREASURY_WALLET) {
    await pool.query(
      `INSERT INTO tribunal_appeal_fee_operations (fee_id, operation, amount_atomic, destination_wallet)
       SELECT f.id, 'treasury', f.charged_fee_atomic, $1 FROM tribunal_appeal_fees f
        WHERE f.state = 'treasury_pending' AND NOT EXISTS
          (SELECT 1 FROM tribunal_appeal_fee_operations o WHERE o.fee_id = f.id)
       ON CONFLICT (fee_id) DO NOTHING`, [config.TREASURY_WALLET],
    );
  }
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM tribunal_appeal_fee_operations WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown')
      ORDER BY created_at LIMIT $1`, [limit],
  );
  const result = { examined: due.rows.length, confirmed: 0, submitted: 0, errors: [] as { operationId: string; code: string }[] };
  for (const item of due.rows) {
    const db = await pool.connect();
    let locked = false;
    try {
      await db.query("SELECT pg_advisory_lock(hashtext($1))", [`appeal-fee-operation:${item.id}`]);
      locked = true;
      const operation = await db.query<{
        id: string; fee_id: string; operation: "refund" | "treasury"; amount_atomic: string; destination_wallet: string;
        fee_wallet_public_key: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer;
        encryption_key_version: number; mint: string;
      }>(
        `SELECT o.id, o.fee_id, o.operation, o.amount_atomic::text, o.destination_wallet,
                f.fee_wallet_public_key, f.encrypted_secret_key, f.encryption_nonce, f.encryption_auth_tag,
                f.encryption_key_version, f.mint
           FROM tribunal_appeal_fee_operations o JOIN tribunal_appeal_fees f ON f.id = o.fee_id
          WHERE o.id = $1 FOR UPDATE OF o`, [item.id],
      );
      const op = operation.rows[0];
      if (!op) continue;
      const last = await db.query<{
        id: string; transaction_signature: string; signed_transaction: Buffer; last_valid_block_height: string; state: string;
      }>(
        `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
           FROM tribunal_appeal_fee_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [op.id],
      );
      let attempt: typeof last.rows[number] | undefined = last.rows[0];
      if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
        const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
        if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
          await db.query("BEGIN");
          await db.query("UPDATE tribunal_appeal_fee_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
          await db.query("UPDATE tribunal_appeal_fee_operations SET state = 'confirmed', updated_at = now() WHERE id = $1", [op.id]);
          await db.query("UPDATE tribunal_appeal_fees SET state = 'complete', updated_at = now() WHERE id = $1", [op.fee_id]);
          await db.query("COMMIT");
          result.confirmed += 1;
          continue;
        }
        if ((!status || !status.err) && await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
          await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
          await db.query("UPDATE tribunal_appeal_fee_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
          await db.query("UPDATE tribunal_appeal_fee_operations SET state = 'submitted', updated_at = now() WHERE id = $1", [op.id]);
          result.submitted += 1;
          continue;
        }
        if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
          await db.query("UPDATE tribunal_appeal_fee_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
          attempt = undefined;
        } else {
          await db.query("UPDATE tribunal_appeal_fee_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
          await db.query("UPDATE tribunal_appeal_fee_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [op.id]);
          throw new ApiError(409, "appeal_fee_outcome_unknown", "The appeal-fee transfer expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
        }
      }
      const mint = new PublicKey(op.mint);
      const sourceOwner = new PublicKey(op.fee_wallet_public_key);
      const recipient = new PublicKey(op.destination_wallet);
      const source = getAssociatedTokenAddressSync(mint, sourceOwner);
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
      if (!sourceInfo) throw new Error("Tribunal appeal fee EOA has no USDC token account.");
      const sourceBalance = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
      if (sourceBalance < BigInt(op.amount_atomic)) throw new Error("Tribunal appeal fee EOA balance is below its recorded operation amount.");
      const secret = decryptSolanaSecretKey({ ciphertext: op.encrypted_secret_key, nonce: op.encryption_nonce,
        authTag: op.encryption_auth_tag, keyVersion: op.encryption_key_version });
      const authority = Keypair.fromSecretKey(secret);
      if (!authority.publicKey.equals(sourceOwner)) throw new Error("Tribunal appeal fee key does not match its recorded address.");
      const payer = loadSolanaFeePayer();
      const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: payer.publicKey, ...latestBlockhash }).add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, authority.publicKey, BigInt(op.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
      );
      transaction.partialSign(payer, authority);
      if (!transaction.signature) throw new Error("Signed Tribunal appeal fee operation has no transaction signature.");
      const signature = bs58.encode(transaction.signature);
      const saved = await db.query<{ id: string }>(
        `INSERT INTO tribunal_appeal_fee_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [op.id, signature, transaction.serialize(), latestBlockhash.blockhash, latestBlockhash.lastValidBlockHeight],
      );
      await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
      await db.query("UPDATE tribunal_appeal_fee_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [saved.rows[0].id]);
      await db.query("UPDATE tribunal_appeal_fee_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [op.id, signature]);
      result.submitted += 1;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      result.errors.push({ operationId: item.id, code: error instanceof Error ? error.message : "appeal_fee_reconcile_failed" });
    } finally {
      if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`appeal-fee-operation:${item.id}`]).catch(() => undefined);
      db.release();
    }
  }
  return result;
}
