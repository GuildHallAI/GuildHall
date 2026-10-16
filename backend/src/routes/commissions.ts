import express, { Router } from "express";
import { z } from "zod";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { settleCommission } from "../escrow-settlement.js";
import { ApiError } from "../http.js";
import { decryptPrivateData } from "../private-data.js";
import { openTribunalCase } from "../tribunal.js";
import { evidenceItemSchema, submitCommissionWork } from "../commission-work.js";
import { claimCommissionForWallet, commissionFundingMessageHash, commissionFundingMessageMatches, createCommissionForWallet, getCommissionFundingInstructions, publicCommission } from "../commission-service.js";
import { reviewCommissionSubmission } from "../commission-review.js";
import { discardStagedCommissionImage, stageCommissionImage } from "../commission-assets.js";
import { readCommissionImage } from "../cloudinary-assets.js";
import { commissionReceipt, commissionTermsRecord } from "../commission-receipts.js";
import { commissionTermsHash, transactionAnchorsTerms } from "../commission-terms.js";

const router = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const uuidSchema = z.string().uuid();
const signatureSchema = z.string().min(80).max(100);

type CommissionRow = {
  id: string;
  client_wallet: string;
  provider_wallet: string | null;
  title: string;
  description: string;
  asset_mint: string;
  amount_atomic: string;
  status: string;
  work_type?: string;
  work_category?: string;
  sla_hours?: number | null;
  proof_schema?: string[] | null;
  deadline_at: Date;
  accepted_at: Date | null;
  funding_signature: string | null;
  funded_at: Date | null;
  created_at: Date;
  updated_at: Date;
  escrow_address?: string;
};

async function commissionById(id: string) {
  const result = await pool.query<CommissionRow>(
    `SELECT c.*, w.public_key AS escrow_address, a.name AS provider_agent_name
     FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
     LEFT JOIN work_agents a ON a.id = c.provider_agent_id
     WHERE c.id = $1`,
    [id],
  );
  if (!result.rowCount) throw new ApiError(404, "commission_not_found", "Commission not found.");
  return result.rows[0];
}

router.get("/assets", (_request, response) => {
  response.json({
    data: {
      USDC: config.USDC_MINT ?? null,
      USDT: config.USDT_MINT ?? null,
      decimals: 6,
      cluster: config.SOLANA_CLUSTER,
    },
  });
});

router.get("/", async (request, response) => {
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().datetime().optional(),
  }).parse(request.query);
  const result = await pool.query<CommissionRow>(
    `SELECT c.*, w.public_key AS escrow_address, a.name AS provider_agent_name
     FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
     LEFT JOIN work_agents a ON a.id = c.provider_agent_id
     WHERE c.status = 'open' AND c.accepted_at IS NULL AND c.work_type IN ('standard', 'interop') AND c.deadline_at > now()
       AND ($1::timestamptz IS NULL OR c.created_at < $1)
     ORDER BY c.created_at DESC LIMIT $2`,
    [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows.map(publicCommission) });
});

router.get("/mine", requireAuth, async (request, response) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  const result = await pool.query<CommissionRow>(
    `SELECT c.*, w.public_key AS escrow_address, a.name AS provider_agent_name
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
       LEFT JOIN work_agents a ON a.id = c.provider_agent_id
      WHERE c.client_user_id = $1 OR c.provider_user_id = $1
      ORDER BY c.updated_at DESC LIMIT $2`, [request.auth!.userId, query.limit],
  );
  response.json({ data: result.rows.map(publicCommission) });
});

router.post("/", requireAuth, async (request, response) => {
  const result = await createCommissionForWallet(request.auth!, request.header("idempotency-key"), request.body);
  response.status(result.idempotentReplay ? 200 : 201).json(result);
});

router.post("/:id/cancel", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      client_user_id: string; status: string; accepted_at: Date | null; funding_signature: string | null; asset_mint: string;
      funding_instructions_last_valid_block_height: string | null; escrow_address: string | null;
    }>(
      `SELECT c.client_user_id, c.status, c.accepted_at, c.funding_signature, c.asset_mint,
              c.funding_instructions_last_valid_block_height::text, w.public_key AS escrow_address
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.id = $1 FOR UPDATE OF c`, [id],
    );
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.client_user_id !== request.auth!.userId) {
      throw new ApiError(403, "commission_cancel_forbidden", "Only the commission owner can take it down.");
    }
    if (commission.status === "cancelled") {
      await client.query("COMMIT");
      response.json({ data: { id, status: "cancelled", alreadyCancelled: true } });
      return;
    }
    if (commission.status !== "open" || commission.accepted_at || commission.funding_signature) {
      throw new ApiError(409, "commission_not_cancellable", "Only an unclaimed, open, unfunded commission can be taken down.");
    }

    const surety = await client.query<{ state: string }>(
      `SELECT state FROM surety_policies
        WHERE commission_id = $1 AND state IN ('awaiting_premium', 'active', 'claim_pending', 'claim_submitted')
        LIMIT 1`, [id],
    );
    if (surety.rows[0]) {
      throw new ApiError(409, "commission_surety_active", "Cancel or resolve this commission's Surety policy before taking it down.");
    }
    if (commission.funding_instructions_last_valid_block_height) {
      const currentHeight = await connection.getBlockHeight("processed");
      if (currentHeight <= Number(commission.funding_instructions_last_valid_block_height)) {
        throw new ApiError(409, "funding_transaction_still_valid", "Wait for the funding transaction to confirm or expire before taking down this commission.");
      }
    }
    if (commission.escrow_address) {
      const escrowTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(commission.asset_mint), new PublicKey(commission.escrow_address),
      );
      const account = await connection.getAccountInfo(escrowTokenAccount, "processed");
      if (account) {
        const balance = await connection.getTokenAccountBalance(escrowTokenAccount, "processed");
        if (BigInt(balance.value.amount) > 0n) {
          throw new ApiError(409, "commission_escrow_not_empty", "This commission's escrow already has funds. Confirm its funding before taking it down.");
        }
      }
    }

    await client.query(
      "UPDATE interop_job_exports SET unpublished_at = COALESCE(unpublished_at, now()) WHERE commission_id = $1",
      [id],
    );
    await client.query(
      `UPDATE commissions
          SET status = 'cancelled', provider_user_id = NULL, provider_agent_id = NULL,
              provider_wallet = CASE WHEN provider_wallet_locked THEN provider_wallet ELSE NULL END,
              accepted_at = NULL, updated_at = now()
        WHERE id = $1`, [id],
    );
    await client.query("COMMIT");
    response.json({ data: { id, status: "cancelled", alreadyCancelled: false } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

router.get("/:id", async (request, response) => {
  const commission = await commissionById(uuidSchema.parse(request.params.id));
  response.json({ data: publicCommission(commission) });
});

router.get("/:id/receipt", async (request, response) => {
  response.json({ data: await commissionReceipt(uuidSchema.parse(request.params.id)) });
});

router.get("/:id/terms", async (request, response) => {
  response.json({ data: await commissionTermsRecord(uuidSchema.parse(request.params.id)) });
});

router.post("/:id/funding-instructions", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  response.json({ data: await getCommissionFundingInstructions(id, request.auth!.userId) });
});

router.post("/:id/funding/submit", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const { signedTransaction } = z.object({
    signedTransaction: z.string().min(1).max(2_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).parse(request.body);
  const rawTransaction = Buffer.from(signedTransaction, "base64");
  if (!rawTransaction.length || rawTransaction.length > 1_232 || rawTransaction.toString("base64") !== signedTransaction) {
    throw new ApiError(400, "invalid_funding_transaction", "The signed funding transaction is malformed or too large.");
  }

  let transaction: Transaction;
  try { transaction = Transaction.from(rawTransaction); }
  catch { throw new ApiError(400, "invalid_funding_transaction", "The signed funding transaction could not be decoded."); }
  if (!transaction.recentBlockhash || !transaction.feePayer || transaction.signatures.length !== 1
    || !transaction.verifySignatures()) {
    throw new ApiError(422, "invalid_funding_signature", "The funding transaction must contain a valid signature from its client wallet.");
  }
  const signatureEntry = transaction.signatures[0];
  if (!signatureEntry.signature) throw new ApiError(422, "invalid_funding_signature", "The signed funding transaction is missing its wallet signature.");
  const signature = bs58.encode(signatureEntry.signature);
  const messageHash = commissionFundingMessageHash(transaction);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<CommissionRow & {
      client_user_id: string; funding_instructions_message_hash: string | null;
      funding_submission_signature: string | null; funding_instructions_last_valid_block_height: string | null;
    }>(
      `SELECT c.*, w.public_key AS escrow_address FROM commissions c
        LEFT JOIN commission_escrow_wallets w ON w.commission_id=c.id
       WHERE c.id=$1 FOR UPDATE OF c`, [id],
    );
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.client_user_id !== request.auth!.userId || commission.client_wallet !== request.auth!.walletAddress) {
      throw new ApiError(403, "commission_funding_forbidden", "Only the commission owner can submit its funding transaction.");
    }
    if (commission.status !== "open" || commission.funding_signature) {
      throw new ApiError(409, "commission_not_fundable", "This commission is no longer awaiting funding.");
    }
    if (!commission.escrow_address || !commission.funding_instructions_message_hash
      || messageHash !== commission.funding_instructions_message_hash
      || !commissionFundingMessageMatches(transaction, commission)) {
      throw new ApiError(409, "funding_transaction_mismatch", "This signed transaction does not match the latest funding instructions. Refresh and sign the current transaction.");
    }
    if (!transaction.feePayer.equals(new PublicKey(commission.client_wallet))
      || !signatureEntry.publicKey.equals(new PublicKey(commission.client_wallet))) {
      throw new ApiError(422, "funding_wallet_mismatch", "The commission client wallet must sign and pay for this funding transaction.");
    }
    const surety = await client.query<{ state: string }>("SELECT state FROM surety_policies WHERE commission_id=$1", [id]);
    if (surety.rows[0]?.state === "awaiting_premium") {
      throw new ApiError(409, "surety_premium_required", "Confirm or cancel this commission's Surety premium before funding it.");
    }
    if (commission.funding_submission_signature && commission.funding_submission_signature !== signature) {
      throw new ApiError(409, "funding_submission_pending", "Another signed funding transaction is already awaiting confirmation.");
    }
    await client.query("UPDATE commissions SET funding_submission_signature=$2 WHERE id=$1", [id, signature]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const existing = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const priorStatus = existing.value[0];
  if (priorStatus?.err) throw new ApiError(422, "funding_transaction_failed", "This signed funding transaction failed on Solana. Wait for it to expire before preparing another.");
  if (priorStatus) {
    response.json({ data: { signature, submitted: true, alreadyObserved: true } });
    return;
  }
  const valid = await connection.isBlockhashValid(transaction.recentBlockhash, { commitment: config.SOLANA_COMMITMENT });
  if (!valid.value) throw new ApiError(409, "funding_transaction_expired", "This signed transaction has expired. Prepare fresh funding instructions and sign again.");
  try {
    const submittedSignature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: config.SOLANA_COMMITMENT,
      maxRetries: 3,
    });
    if (submittedSignature !== signature) throw new ApiError(502, "funding_signature_mismatch", "Solana returned a different transaction signature than the wallet signed.");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const observed = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null);
    if (!observed?.value[0]) {
      console.error("[commission-funding] RPC submission failed", error);
      throw new ApiError(502, "funding_relay_failed", "GuildHall could not confirm transaction submission. The signed transaction is saved; use Check transaction confirmation to retry safely.");
    }
    if (observed.value[0].err) throw new ApiError(422, "funding_transaction_failed", "The funding transaction failed on Solana.");
  }
  response.json({ data: { signature, submitted: true, alreadyObserved: false } });
});

router.post("/:id/accept", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  response.json({ data: await claimCommissionForWallet(id, request.auth!) });
});

router.post("/:id/funding/confirm", async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const { signature } = z.object({ signature: signatureSchema }).parse(request.body);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(signature);
  } catch {
    throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded.");
  }
  if (signatureBytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");

  const initial = await commissionById(id);
  const surety = await pool.query<{ state: string }>("SELECT state FROM surety_policies WHERE commission_id = $1", [id]);
  if (surety.rows[0]?.state === "awaiting_premium") throw new ApiError(409, "surety_premium_required", "Confirm or cancel this commission's Surety premium before funding it.");
  if (!initial.escrow_address) throw new ApiError(409, "escrow_unavailable", "The commission escrow account is not ready.");
  if (initial.deadline_at <= new Date()) throw new ApiError(409, "commission_expired", "The commission deadline has passed and the commission can no longer be funded.");
  if (initial.funding_signature === signature) {
    response.json({ data: publicCommission(initial), idempotentReplay: true });
    return;
  }
  if (initial.funding_signature || initial.status !== "open") throw new ApiError(409, "commission_not_fundable", "This commission is not awaiting funding.");

  const statusResult = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const signatureStatus = statusResult.value[0];
  if (!signatureStatus) throw new ApiError(409, "funding_not_confirmed", "The funding transaction was not found on this cluster.");
  if (signatureStatus.err) throw new ApiError(422, "funding_failed", "The funding transaction failed on Solana.");
  if (!["confirmed", "finalized"].includes(signatureStatus.confirmationStatus ?? "")) {
    throw new ApiError(409, "funding_not_confirmed", "Wait for the funding transaction to confirm, then retry.");
  }
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "funding_transaction_unavailable", "The confirmed funding transaction details are not available yet.");

  const clientSigned = parsed.transaction.message.accountKeys.some(
    (account) => account.pubkey.toBase58() === initial.client_wallet && account.signer,
  );
  if (!clientSigned) throw new ApiError(422, "funding_wallet_mismatch", "The commission client wallet did not sign this transaction.");

  const mint = new PublicKey(initial.asset_mint);
  const escrow = new PublicKey(initial.escrow_address);
  const tokenAccount = getAssociatedTokenAddressSync(mint, escrow).toBase58();
  const tokenAccountIndex = parsed.transaction.message.accountKeys.findIndex(
    (account) => account.pubkey.toBase58() === tokenAccount,
  );
  if (tokenAccountIndex < 0) throw new ApiError(422, "funding_amount_mismatch", "The transaction did not include the commission token account.");
  const amountForIndex = (balances: typeof parsed.meta.preTokenBalances, index: number) =>
    balances?.filter((balance) => balance.accountIndex === index && balance.mint === mint.toBase58())
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
  const delta = amountForIndex(parsed.meta.postTokenBalances, tokenAccountIndex)
    - amountForIndex(parsed.meta.preTokenBalances, tokenAccountIndex);
  const expectedAmount = BigInt(initial.amount_atomic);
  const clientTokenDelta = (parsed.meta.postTokenBalances ?? [])
    .filter((balance) => balance.mint === mint.toBase58() && balance.owner === initial.client_wallet)
    .reduce((sum, postBalance) => {
      const preBalance = (parsed.meta!.preTokenBalances ?? []).find(
        (balance) => balance.accountIndex === postBalance.accountIndex && balance.mint === mint.toBase58(),
      );
      return sum + BigInt(postBalance.uiTokenAmount.amount) - BigInt(preBalance?.uiTokenAmount.amount ?? "0");
    }, 0n);
  const destinationBalance = (parsed.meta.postTokenBalances ?? []).find(
    (balance) => balance.accountIndex === tokenAccountIndex && balance.mint === mint.toBase58(),
  );
  if (destinationBalance?.uiTokenAmount.decimals !== 6) {
    throw new ApiError(422, "funding_asset_mismatch", "The commission token account does not use the expected six decimal units.");
  }
  if (delta.toString() !== initial.amount_atomic) {
    throw new ApiError(422, "funding_amount_mismatch", "The confirmed token transfer does not match the commission amount.");
  }
  if (clientTokenDelta !== -expectedAmount) {
    throw new ApiError(422, "funding_wallet_mismatch", "The client wallet must fund the commission from its own token balance.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<CommissionRow>("SELECT * FROM commissions WHERE id = $1 FOR UPDATE", [id]);
    const commission = locked.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    const surety = await client.query<{ state: string }>("SELECT state FROM surety_policies WHERE commission_id = $1", [id]);
    if (surety.rows[0]?.state === "awaiting_premium") throw new ApiError(409, "surety_premium_required", "Confirm or cancel this commission's Surety premium before funding it.");
    if (commission.funding_signature === signature) {
      await client.query("COMMIT");
      response.json({ data: publicCommission(await commissionById(id)), idempotentReplay: true });
      return;
    }
    if (commission.status !== "open" || commission.funding_signature) {
      throw new ApiError(409, "commission_not_fundable", "This commission is not awaiting funding.");
    }
    await client.query(
      `INSERT INTO commission_escrow_operations
         (commission_id, idempotency_key, operation, asset_kind, mint, amount_atomic, destination, state, transaction_signature)
       VALUES ($1, $2, 'fund', 'spl', $3, $4, $5, 'confirmed', $2)`,
      [id, `fund:${signature}`, mint.toBase58(), initial.amount_atomic, tokenAccount],
    );
    const termsHash = commissionTermsHash(commission);
    const termsAnchored = transactionAnchorsTerms(parsed.transaction.message.instructions, termsHash);
    const updated = await client.query<CommissionRow>(
      `UPDATE commissions SET status = 'funded', funding_signature = $2,
         funding_submission_signature = NULL, funding_instructions_message_hash = NULL,
         funded_at = now(), terms_hash = $3, terms_hashed_at = now(), terms_anchored = $4,
         updated_at = now() WHERE id = $1 RETURNING *`,
      [id, signature, termsHash, termsAnchored],
    );
    await client.query("COMMIT");
    response.json({ data: publicCommission({ ...updated.rows[0], escrow_address: initial.escrow_address }), idempotentReplay: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/:id/submissions", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const submission = await submitCommissionWork(id, request.auth!.userId, request.body);
  response.status(201).json({ data: submission });
});

router.post("/:id/submission-assets", requireAuth,
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "10mb" }), async (request, response) => {
    const id = uuidSchema.parse(request.params.id);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "image_required", "Send a PNG, JPEG, or WebP image as the request body.");
    const asset = await stageCommissionImage({
      commissionId: id,
      providerUserId: request.auth!.userId,
      bytes: request.body,
      contentType: String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    });
    response.status(201).json({ data: asset });
  });

router.delete("/:id/submission-assets/:assetId", requireAuth, async (request, response) => {
  const commissionId = uuidSchema.parse(request.params.id);
  const assetId = uuidSchema.parse(request.params.assetId);
  await discardStagedCommissionImage({ commissionId, assetId, providerUserId: request.auth!.userId });
  response.status(204).end();
});

router.get("/:id/submissions", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const commission = await commissionById(id);
  const member = await pool.query(
    "SELECT 1 FROM commissions WHERE id = $1 AND (client_user_id = $2 OR provider_user_id = $2)",
    [id, request.auth!.userId],
  );
  if (!member.rowCount) throw new ApiError(403, "commission_forbidden", "Only commission participants can view submitted evidence.");
  const submissions = await pool.query<{
    id: string; revision: number; submitted_at: Date; encryption_key_version: number;
    encrypted_payload: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer;
  }>(
    `SELECT id, revision, encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version, submitted_at FROM commission_submissions
     WHERE commission_id = $1 ORDER BY revision ASC`, [commission.id],
  );
  response.json({ data: submissions.rows.map(({ encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version, ...row }) => ({
    ...row,
    ...decryptPrivateData<{ summary: string; evidence: z.infer<typeof evidenceItemSchema>[] }>({
      ciphertext: encrypted_payload, nonce: encryption_nonce, authTag: encryption_auth_tag,
      keyVersion: encryption_key_version,
    }),
  })) });
});

router.get("/:id/activity", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const member = await pool.query(
    "SELECT 1 FROM commissions WHERE id = $1 AND (client_user_id = $2 OR provider_user_id = $2)",
    [id, request.auth!.userId],
  );
  if (!member.rowCount) throw new ApiError(403, "commission_forbidden", "Only commission participants can view its activity.");
  const result = await pool.query<{ id: string; event_type: string; details: Record<string, unknown>; created_at: Date }>(
    `SELECT id, event_type, details, created_at FROM commission_activity
      WHERE commission_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [id],
  );
  response.json({ data: result.rows.reverse().map((row) => ({
    id: row.id.toString(), type: row.event_type, details: row.details, createdAt: row.created_at,
  })) });
});

router.get("/:id/submissions/:submissionId/assets/:assetId", requireAuth, async (request, response) => {
  const commissionId = uuidSchema.parse(request.params.id);
  const submissionId = uuidSchema.parse(request.params.submissionId);
  const assetId = uuidSchema.parse(request.params.assetId);
  const asset = await pool.query<{ content_type: string; cloudinary_public_id: string; format: string }>(
    `SELECT a.content_type, a.cloudinary_public_id, a.format
       FROM commission_submission_assets a
       JOIN commissions c ON c.id = a.commission_id
      WHERE a.id = $1 AND a.commission_id = $2 AND a.submission_id = $3
        AND (c.client_user_id = $4 OR c.provider_user_id = $4)`,
    [assetId, commissionId, submissionId, request.auth!.userId],
  );
  if (!asset.rows[0]) throw new ApiError(404, "commission_image_not_found", "Image not found for this commission submission.");
  const bytes = await readCommissionImage(asset.rows[0].cloudinary_public_id, asset.rows[0].format);
  response.setHeader("Content-Type", asset.rows[0].content_type);
  response.setHeader("Content-Length", bytes.length);
  response.setHeader("Content-Disposition", "inline");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.status(200).send(bytes);
});

router.post("/:id/review", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const result = await reviewCommissionSubmission(id, request.auth!.userId, request.body);
  response.status(201).json(result);
});

router.post("/:id/disputes", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const input = z.object({
    reason: z.string().trim().min(1).max(10000),
    evidence: z.array(evidenceItemSchema).max(50).default([]),
  }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const selected = await client.query<CommissionRow & { client_user_id: string; provider_user_id: string | null }>(
      "SELECT * FROM commissions WHERE id = $1 FOR UPDATE", [id],
    );
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (![commission.client_user_id, commission.provider_user_id].includes(request.auth!.userId)) throw new ApiError(403, "commission_forbidden", "Only commission participants can open a dispute.");
    if (!["funded", "submitted"].includes(commission.status)) throw new ApiError(409, "commission_not_disputable", "This commission cannot be disputed in its current state.");
    if (!commission.provider_user_id) throw new ApiError(409, "provider_missing", "A provider must accept the commission before it can enter Tribunal.");
    const submission = await client.query("SELECT 1 FROM commission_submissions WHERE commission_id = $1 LIMIT 1", [id]);
    if (!submission.rowCount) throw new ApiError(409, "submission_required_for_dispute", "A Tribunal dispute requires a submitted work item; missed deadlines can be refunded directly.");
    const opened = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO tribunal_cases (commission_id, opened_by, reason, evidence)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id, created_at`,
      [id, request.auth!.userId, input.reason, JSON.stringify(input.evidence)],
    );
    await client.query("UPDATE commissions SET status = 'disputed', updated_at = now() WHERE id = $1", [id]);
    await client.query("COMMIT");
    const wardenAssigned = await openTribunalCase(opened.rows[0].id).catch(() => false);
    response.status(201).json({ data: { id: opened.rows[0].id, commissionId: id,
      stage: wardenAssigned ? "warden" : "unassigned", wardenAssigned, createdAt: opened.rows[0].created_at } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/:id/disputes", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const commission = await pool.query<{ client_user_id: string; provider_user_id: string | null }>(
    "SELECT client_user_id, provider_user_id FROM commissions WHERE id = $1", [id],
  );
  if (!commission.rowCount) throw new ApiError(404, "commission_not_found", "Commission not found.");
  if (![commission.rows[0].client_user_id, commission.rows[0].provider_user_id].includes(request.auth!.userId)) {
    throw new ApiError(403, "commission_forbidden", "Only commission participants can view this dispute.");
  }
  const result = await pool.query(
    `SELECT tc.id, tc.reason, tc.evidence, tc.stage, tc.outcome, tc.decision_summary, tc.created_at, tc.updated_at,
            COALESCE(jsonb_agg(jsonb_build_object('tier', tv.tier, 'verdict', tv.verdict, 'rationale', tv.rationale, 'createdAt', tv.created_at))
              FILTER (WHERE tv.id IS NOT NULL), '[]'::jsonb) AS votes
     FROM tribunal_cases tc LEFT JOIN tribunal_votes tv ON tv.case_id = tc.id
     WHERE tc.commission_id = $1 GROUP BY tc.id`, [id],
  );
  response.json({ data: result.rows[0] ?? null });
});

router.post("/:id/settle", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const commission = await pool.query<{ client_user_id: string }>(
    "SELECT client_user_id FROM commissions WHERE id = $1", [id],
  );
  if (!commission.rowCount) throw new ApiError(404, "commission_not_found", "Commission not found.");
  if (commission.rows[0].client_user_id !== request.auth!.userId) {
    throw new ApiError(403, "commission_forbidden", "Only the commission client can authorize settlement.");
  }
  const result = await settleCommission(id, "release");
  response.status(result.state === "confirmed" ? 200 : 202).json({ data: result });
});

router.post("/:id/refund-expired", async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const result = await settleCommission(id, "refund");
  response.status(result.state === "confirmed" ? 200 : 202).json({ data: result });
});

export const commissionsRouter = router;
