import { Router } from "express";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { SolanaSDK } from "8004-solana";
import bs58 from "bs58";
import { z } from "zod";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";

export const registryRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const registryProgramOverrides = config.AGENT_REGISTRY_PROGRAM_ID || config.AGENT_REGISTRY_ATOM_PROGRAM_ID
  ? {
    ...(config.AGENT_REGISTRY_PROGRAM_ID ? { agentRegistry: config.AGENT_REGISTRY_PROGRAM_ID } : {}),
    ...(config.AGENT_REGISTRY_ATOM_PROGRAM_ID ? { atomEngine: config.AGENT_REGISTRY_ATOM_PROGRAM_ID } : {}),
  }
  : undefined;
const registrySdk = new SolanaSDK({
  cluster: config.SOLANA_CLUSTER,
  rpcUrl: config.SOLANA_RPC_URL,
  useIndexer: false,
  forceOnChain: true,
  ...(registryProgramOverrides ? { programIds: registryProgramOverrides } : {}),
});

async function verifyRegistryAssetOwner(asset: PublicKey, wallet: PublicKey) {
  const agent = await registrySdk.loadAgent(asset);
  if (!agent) throw new ApiError(404, "registry_agent_not_found", "That asset is not registered in the Solana Agent Registry on the configured cluster.");
  if (!agent.getOwnerPublicKey().equals(wallet)) throw new ApiError(403, "registry_agent_owner_mismatch", "The connected wallet must own the linked Solana Agent Registry asset.");
  return agent;
}

async function providerRecord(walletInput: string, requireOnchainRecord = false) {
  let wallet: string;
  try {
    wallet = new PublicKey(walletInput).toBase58();
  } catch {
    throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required.");
  }
  const result = await pool.query<{
    user_id: string;
    wallet_address: string;
    settled_commissions: number;
    paid_amount_atomic: string;
    distinct_clients: number;
    accepted_commissions: number;
    lost_appeals: number;
    feedback_count: number;
    weighted_rating: string | null;
  }>(
    `WITH raw_paid_work AS (
       SELECT w.id, w.commission_id, w.client_user_id, w.provider_user_id AS worker_user_id,
              w.paid_amount_atomic AS paid_amount_atomic, w.outcome
         FROM work_records w
        WHERE NOT EXISTS (SELECT 1 FROM work_record_payouts p WHERE p.work_record_id = w.id)
          AND ($2::boolean = false OR EXISTS (SELECT 1 FROM work_record_chain_operations chain WHERE chain.work_record_id = w.id AND chain.state = 'confirmed'))
       UNION ALL
       SELECT w.id, w.commission_id, w.client_user_id, p.user_id AS worker_user_id,
              p.amount_atomic AS paid_amount_atomic, w.outcome
         FROM work_records w JOIN work_record_payouts p ON p.work_record_id = w.id
        WHERE $2::boolean = false OR EXISTS (SELECT 1 FROM work_record_chain_operations chain WHERE chain.work_record_id = w.id AND chain.state = 'confirmed')
     ), reputation_work AS (
       SELECT candidate.*
         FROM raw_paid_work candidate
        WHERE candidate.client_user_id <> candidate.worker_user_id
          AND NOT EXISTS (
            SELECT 1 FROM raw_paid_work reverse
             WHERE reverse.client_user_id = candidate.worker_user_id
               AND reverse.worker_user_id = candidate.client_user_id
               AND reverse.paid_amount_atomic > 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM raw_paid_work second_hop
            JOIN raw_paid_work closing_hop
              ON closing_hop.client_user_id = second_hop.worker_user_id
             AND closing_hop.worker_user_id = candidate.client_user_id
             AND closing_hop.paid_amount_atomic > 0
             WHERE second_hop.client_user_id = candidate.worker_user_id
               AND second_hop.paid_amount_atomic > 0
          )
     ), paid_work AS (
       SELECT * FROM reputation_work WHERE paid_amount_atomic > 0
     ), lost_appeals AS (
       SELECT rw.worker_user_id,
              count(*) FILTER (WHERE tc.stage = 'decided' AND tc.appealed_by IS NOT NULL
                                AND tc.appealed_by = rw.worker_user_id
                                AND tc.outcome IN ('client', 'split'))::int AS lost_appeals
         FROM reputation_work rw
         LEFT JOIN tribunal_cases tc ON tc.commission_id = rw.commission_id
        GROUP BY rw.worker_user_id
     ), paid_stats AS (
       SELECT worker_user_id, sum(paid_amount_atomic)::text AS paid_amount_atomic,
              count(DISTINCT client_user_id)::int AS distinct_clients
         FROM paid_work GROUP BY worker_user_id
     ), reputation_stats AS (
       SELECT worker_user_id, count(*)::int AS settled_commissions,
              count(*) FILTER (WHERE outcome IN ('accepted', 'tribunal_provider'))::int AS accepted_commissions
         FROM reputation_work GROUP BY worker_user_id
     )
     SELECT u.id AS user_id, u.wallet_address,
            COALESCE(rep.settled_commissions, 0)::int AS settled_commissions,
            COALESCE(paid.paid_amount_atomic, '0') AS paid_amount_atomic,
            COALESCE(paid.distinct_clients, 0)::int AS distinct_clients,
            COALESCE(rep.accepted_commissions, 0)::int AS accepted_commissions,
            COALESCE(lost.lost_appeals, 0)::int AS lost_appeals,
            (SELECT count(*)::int FROM work_record_feedback f WHERE f.target_user_id = u.id) AS feedback_count,
            (SELECT (sum(f.rating::numeric * f.weight_atomic) / NULLIF(sum(f.weight_atomic), 0))::text
               FROM work_record_feedback f WHERE f.target_user_id = u.id) AS weighted_rating
       FROM wallet_users u LEFT JOIN paid_stats paid ON paid.worker_user_id = u.id
       LEFT JOIN reputation_stats rep ON rep.worker_user_id = u.id
       LEFT JOIN lost_appeals lost ON lost.worker_user_id = u.id
      WHERE u.wallet_address = $1`, [wallet, requireOnchainRecord],
  );
  if (!result.rowCount) {
    return {
      walletAddress: wallet, settledCommissions: 0, paidAmountAtomic: "0", distinctClients: 0,
      acceptedCommissions: 0, acceptanceRate: 0, lostAppeals: 0, feedbackCount: 0, weightedRating: null,
    };
  }
  const row = result.rows[0];
  return {
    walletAddress: row.wallet_address,
    settledCommissions: row.settled_commissions,
    acceptedCommissions: row.accepted_commissions,
    paidAmountAtomic: row.paid_amount_atomic,
    distinctClients: row.distinct_clients,
    acceptanceRate: row.settled_commissions === 0 ? 0 : row.accepted_commissions / row.settled_commissions,
    lostAppeals: row.lost_appeals,
    feedbackCount: row.feedback_count,
    weightedRating: row.weighted_rating === null ? null : Number(row.weighted_rating),
  };
}

export async function charterEligibility(wallet: string) {
  const record = await providerRecord(wallet, true);
  const checks = {
    acceptedCommissions: record.acceptedCommissions >= 25,
    earnings: BigInt(record.paidAmountAtomic) >= 1_000_000_000n,
    distinctClients: record.distinctClients >= 10,
    acceptanceRate: record.acceptanceRate >= 0.9,
    lostAppeals: record.lostAppeals <= 1,
  };
  return {
    ...record,
    eligible: Object.values(checks).every(Boolean),
    thresholds: {
      acceptedCommissions: 25,
      paidAmountAtomic: "1000000000",
      distinctClients: 10,
      acceptanceRate: 0.9,
      maximumLostAppeals: 1,
    },
    checks,
  };
}

registryRouter.post("/agent-asset", requireAuth, async (request, response) => {
  const input = z.object({ asset: z.string().min(32).max(44) }).parse(request.body);
  let asset: PublicKey;
  try { asset = new PublicKey(input.asset); }
  catch { throw new ApiError(400, "invalid_registry_asset", "A valid Solana Agent Registry asset address is required."); }
  const wallet = new PublicKey(request.auth!.walletAddress);
  await verifyRegistryAssetOwner(asset, wallet);
  try {
    await pool.query(
      `INSERT INTO wallet_registry_agents (user_id, agent_asset)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET agent_asset = EXCLUDED.agent_asset,
         ownership_verified_at = now(), updated_at = now()`,
      [request.auth!.userId, asset.toBase58()],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ApiError(409, "registry_asset_linked", "That Registry asset is already linked to another GuildHall wallet.");
    throw error;
  }
  response.json({ data: { asset: asset.toBase58(), ownerWallet: wallet.toBase58(), ownershipVerified: true } });
});

registryRouter.delete("/agent-asset", requireAuth, async (request, response) => {
  await pool.query("DELETE FROM wallet_registry_agents WHERE user_id = $1", [request.auth!.userId]);
  response.json({ data: { unlinked: true } });
});

registryRouter.get("/:wallet/work-records", async (request, response) => {
  let wallet: string;
  try { wallet = new PublicKey(z.string().min(32).max(44).parse(request.params.wallet)).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() }).parse(request.query);
  const result = await pool.query(
    `WITH payees AS (
       SELECT wr.id AS work_record_id, wr.provider_user_id AS user_id, wr.paid_amount_atomic AS paid_atomic
         FROM work_records wr
        WHERE NOT EXISTS (SELECT 1 FROM work_record_payouts p WHERE p.work_record_id = wr.id)
       UNION ALL
       SELECT p.work_record_id, p.user_id, p.amount_atomic AS paid_atomic
         FROM work_record_payouts p
     )
     SELECT wr.commission_id, wr.provider_agent_id, wr.asset_mint, wr.amount_atomic::text, p.paid_atomic::text AS paid_amount_atomic,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object('wallet', split.wallet_address, 'amountAtomic', split.amount_atomic::text)
                                ORDER BY split.wallet_address)
                 FROM work_record_payouts split WHERE split.work_record_id = wr.id),
              jsonb_build_array(jsonb_build_object('wallet', u.wallet_address, 'amountAtomic', wr.paid_amount_atomic::text))
            ) AS worker_payouts,
            wr.outcome, wr.finalized_at, chain.state AS chain_state,
            chain.transaction_signature AS chain_signature, chain.record_hash, chain.memo_data AS chain_payload
       FROM payees p JOIN work_records wr ON wr.id = p.work_record_id
       JOIN wallet_users u ON u.id = p.user_id
       LEFT JOIN work_record_chain_operations chain ON chain.work_record_id = wr.id
      WHERE u.wallet_address = $1 AND p.paid_atomic > 0
        AND ($2::timestamptz IS NULL OR wr.finalized_at < $2)
      ORDER BY wr.finalized_at DESC, wr.id DESC LIMIT $3`, [wallet, query.before ?? null, query.limit],
  );
  response.json({ data: result.rows, basis: "confirmed commission settlement", nextBefore: result.rows.length === query.limit
    ? result.rows[result.rows.length - 1]?.finalized_at ?? null : null });
});

registryRouter.post("/:wallet/feedback", requireAuth, async (request, response) => {
  const walletInput = z.string().min(32).max(44).parse(request.params.wallet);
  let wallet: string;
  try { wallet = new PublicKey(walletInput).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const input = z.object({
    commissionId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().min(1).max(4000),
  }).parse(request.body);
  const target = await pool.query<{ id: string }>("SELECT id FROM wallet_users WHERE wallet_address = $1", [wallet]);
  if (!target.rows[0]) throw new ApiError(404, "wallet_not_registered", "The feedback target has no GuildHall wallet identity.");
  const work = await pool.query<{ id: string; client_user_id: string; provider_user_id: string; amount_atomic: string; paid_amount_atomic: string; feedback_weight: string | null; reviewer_paid: string | null; has_split_payouts: boolean }>(
    `SELECT wr.id, wr.client_user_id, wr.provider_user_id, wr.amount_atomic, wr.paid_amount_atomic,
            (SELECT p.amount_atomic::text FROM work_record_payouts p
              WHERE p.work_record_id = wr.id AND p.user_id = $2) AS feedback_weight,
            (SELECT p.amount_atomic::text FROM work_record_payouts p
              WHERE p.work_record_id = wr.id AND p.user_id = $3) AS reviewer_paid,
            EXISTS (SELECT 1 FROM work_record_payouts p WHERE p.work_record_id = wr.id) AS has_split_payouts
       FROM work_records wr JOIN commissions c ON c.id = wr.commission_id
      WHERE wr.commission_id = $1 AND c.status IN ('complete', 'refunded')`, [input.commissionId, target.rows[0].id, request.auth!.userId],
  );
  const row = work.rows[0];
  if (!row) throw new ApiError(404, "settled_work_not_found", "No settled work record exists for this commission.");
  let weight: string | null = null;
  if (row.client_user_id === request.auth!.userId) {
    if (row.provider_user_id === target.rows[0].id && BigInt(row.paid_amount_atomic) > 0n) weight = row.paid_amount_atomic;
    else if (row.feedback_weight && BigInt(row.feedback_weight) > 0n) weight = row.feedback_weight;
  } else if ((row.provider_user_id === request.auth!.userId && !row.has_split_payouts && BigInt(row.paid_amount_atomic) > 0n)
    || (row.reviewer_paid !== null && BigInt(row.reviewer_paid) > 0n)) {
    if (target.rows[0].id === row.client_user_id) weight = row.amount_atomic;
  }
  if (!weight || BigInt(weight) <= 0n || target.rows[0].id === request.auth!.userId) {
    throw new ApiError(403, "feedback_not_eligible", "Feedback is limited to parties who participated in a settled, paid commission.");
  }
  const inserted = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO work_record_feedback (work_record_id, reviewer_user_id, target_user_id, rating, comment, weight_atomic)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [row.id, request.auth!.userId, target.rows[0].id, input.rating, input.comment, weight],
  );
  response.status(201).json({ data: { id: inserted.rows[0].id, commissionId: input.commissionId,
    targetWallet: wallet, rating: input.rating, weightAtomic: weight, createdAt: inserted.rows[0].created_at } });
});

registryRouter.post("/:wallet/feedback/:feedbackId/onchain", requireAuth, async (request, response) => {
  let wallet: string;
  try { wallet = new PublicKey(z.string().min(32).max(44).parse(request.params.wallet)).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const feedbackId = z.string().uuid().parse(request.params.feedbackId);
  const reviewerWallet = new PublicKey(request.auth!.walletAddress);
  const feedback = await pool.query<{
    id: string; reviewer_user_id: string; target_user_id: string; rating: number; weight_atomic: string;
    agent_asset: string | null;
  }>(
    `SELECT f.id, f.reviewer_user_id, f.target_user_id, f.rating, f.weight_atomic::text, a.agent_asset
       FROM work_record_feedback f JOIN wallet_users target ON target.id = f.target_user_id
       LEFT JOIN wallet_registry_agents a ON a.user_id = target.id
      WHERE f.id = $1 AND target.wallet_address = $2`, [feedbackId, wallet],
  );
  const row = feedback.rows[0];
  if (!row) throw new ApiError(404, "feedback_not_found", "GuildHall feedback not found.");
  if (row.reviewer_user_id !== request.auth!.userId) throw new ApiError(403, "feedback_reviewer_required", "Only the wallet that submitted this feedback can sign its on-chain Registry entry.");
  if (!row.agent_asset) throw new ApiError(409, "registry_asset_unlinked", "The feedback target has not linked a Solana Agent Registry asset.");
  const asset = new PublicKey(row.agent_asset);
  await verifyRegistryAssetOwner(asset, new PublicKey(wallet));

  const existing = await pool.query<{
    id: string; state: string; transaction_signature: string | null; prepared_transaction: string | null;
    last_valid_block_height: string | null;
  }>("SELECT id, state, transaction_signature, prepared_transaction, last_valid_block_height::text FROM registry_feedback_operations WHERE feedback_id = $1", [feedbackId]);
  const operation = existing.rows[0];
  if (operation?.state === "confirmed") {
    response.json({ data: { feedbackId, state: operation.state, signature: operation.transaction_signature } });
    return;
  }
  if (operation?.state === "submitted") {
    response.status(202).json({ data: { feedbackId, state: operation.state, signature: operation.transaction_signature } });
    return;
  }
  if (operation?.state === "prepared" && operation.prepared_transaction && operation.last_valid_block_height
    && await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(operation.last_valid_block_height)) {
    response.json({ data: { feedbackId, state: "prepared", unsignedTransaction: operation.prepared_transaction,
      lastValidBlockHeight: Number(operation.last_valid_block_height), feePayer: reviewerWallet.toBase58() } });
    return;
  }

  const prepared = await registrySdk.giveFeedback(asset, {
    value: BigInt(row.weight_atomic),
    valueDecimals: 6,
    score: row.rating * 20,
    tag1: "quality",
    tag2: "paid_work",
  }, { skipSend: true, signer: reviewerWallet, feePayer: reviewerWallet });
  if (!("transaction" in prepared) || !prepared.transaction || prepared.signed !== false) {
    throw new ApiError(502, "registry_transaction_unavailable", "The Agent Registry could not prepare a feedback transaction.");
  }
  const preparedTx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  if (!preparedTx.feePayer?.equals(reviewerWallet) || !preparedTx.compileMessage().accountKeys.some((key, index) => key.equals(reviewerWallet) && preparedTx.compileMessage().isAccountSigner(index))) {
    throw new ApiError(502, "registry_transaction_invalid", "The prepared Agent Registry transaction does not require the authenticated wallet to sign.");
  }
  const saved = await pool.query<{ id: string }>(
    `INSERT INTO registry_feedback_operations
       (feedback_id, agent_asset, reviewer_user_id, state, prepared_transaction, recent_blockhash, last_valid_block_height)
     VALUES ($1, $2, $3, 'prepared', $4, $5, $6)
     ON CONFLICT (feedback_id) DO UPDATE SET agent_asset = EXCLUDED.agent_asset, reviewer_user_id = EXCLUDED.reviewer_user_id,
       state = 'prepared', prepared_transaction = EXCLUDED.prepared_transaction, recent_blockhash = EXCLUDED.recent_blockhash,
       last_valid_block_height = EXCLUDED.last_valid_block_height, transaction_signature = NULL, updated_at = now()
     WHERE registry_feedback_operations.state IN ('pending', 'failed', 'prepared') RETURNING id`,
    [feedbackId, asset.toBase58(), request.auth!.userId, prepared.transaction, prepared.blockhash, prepared.lastValidBlockHeight],
  );
  if (!saved.rows[0]) throw new ApiError(409, "registry_feedback_already_submitted", "This feedback transaction has already been submitted.");
  response.json({ data: { feedbackId, state: "prepared", unsignedTransaction: prepared.transaction,
    lastValidBlockHeight: prepared.lastValidBlockHeight, feePayer: reviewerWallet.toBase58(), requiredSigners: [reviewerWallet.toBase58()] } });
});

registryRouter.post("/:wallet/feedback/:feedbackId/onchain/confirm", requireAuth, async (request, response) => {
  let wallet: string;
  try { wallet = new PublicKey(z.string().min(32).max(44).parse(request.params.wallet)).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const feedbackId = z.string().uuid().parse(request.params.feedbackId);
  const input = z.object({ signature: z.string().min(80).max(100) }).parse(request.body);
  let signatureBytes: Uint8Array;
  try { signatureBytes = bs58.decode(input.signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (signatureBytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const operationResult = await pool.query<{
    id: string; reviewer_user_id: string; state: string; transaction_signature: string | null; prepared_transaction: string | null;
    agent_asset: string;
  }>(
    `SELECT op.id, op.reviewer_user_id, op.state, op.transaction_signature, op.prepared_transaction, op.agent_asset
       FROM registry_feedback_operations op JOIN work_record_feedback f ON f.id = op.feedback_id
       JOIN wallet_users target ON target.id = f.target_user_id
       JOIN wallet_registry_agents linked ON linked.user_id = target.id AND linked.agent_asset = op.agent_asset
      WHERE op.feedback_id = $1 AND target.wallet_address = $2`, [feedbackId, wallet],
  );
  const operation = operationResult.rows[0];
  if (!operation) throw new ApiError(404, "registry_feedback_operation_not_found", "No prepared on-chain feedback operation exists.");
  if (operation.reviewer_user_id !== request.auth!.userId) throw new ApiError(403, "feedback_reviewer_required", "Only the wallet that prepared this feedback transaction can confirm it.");
  if (operation.state === "confirmed") {
    if (operation.transaction_signature !== input.signature) throw new ApiError(409, "registry_feedback_already_confirmed", "This feedback was confirmed with another transaction.");
    response.json({ data: { feedbackId, state: "confirmed", signature: input.signature }, idempotentReplay: true });
    return;
  }
  if (!operation.prepared_transaction) throw new ApiError(409, "registry_transaction_not_prepared", "Prepare the Registry transaction before confirming it.");
  await verifyRegistryAssetOwner(new PublicKey(operation.agent_asset), new PublicKey(wallet));
  const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "registry_transaction_unconfirmed", "The feedback transaction must be confirmed on Solana first.");
  }
  const chainTransaction = await connection.getTransaction(input.signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!chainTransaction || chainTransaction.meta?.err) throw new ApiError(409, "registry_transaction_unavailable", "The confirmed feedback transaction details are unavailable.");
  const expected = Transaction.from(Buffer.from(operation.prepared_transaction, "base64"));
  const expectedMessage = expected.compileMessage().serialize();
  const actualMessage = chainTransaction.transaction.message.serialize();
  const actualSignatures = chainTransaction.transaction.signatures;
  const signer = new PublicKey(request.auth!.walletAddress);
  const actualSigner = chainTransaction.transaction.message.staticAccountKeys
    .slice(0, chainTransaction.transaction.message.header.numRequiredSignatures).some((key) => key.equals(signer));
  if (!Buffer.from(actualMessage).equals(expectedMessage) || !actualSignatures.includes(input.signature) || !actualSigner) {
    throw new ApiError(422, "registry_transaction_mismatch", "The confirmed transaction does not match the GuildHall-prepared Registry feedback for this wallet.");
  }
  const updated = await pool.query(
    `UPDATE registry_feedback_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now()
      WHERE id = $1 AND state IN ('prepared', 'submitted') RETURNING id`, [operation.id, input.signature],
  );
  if (!updated.rowCount) throw new ApiError(409, "registry_feedback_state_changed", "This Registry feedback operation changed while it was being confirmed.");
  response.json({ data: { feedbackId, state: "confirmed", signature: input.signature }, idempotentReplay: false });
});

registryRouter.get("/:wallet/feedback", async (request, response) => {
  const walletInput = z.string().min(32).max(44).parse(request.params.wallet);
  let wallet: string;
  try { wallet = new PublicKey(walletInput).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() }).parse(request.query);
  const result = await pool.query(
    `SELECT f.id, reviewer.wallet_address AS reviewer_wallet, f.rating, f.comment,
            f.weight_atomic::text, f.created_at, wr.commission_id,
            chain.state AS registry_state, chain.agent_asset, chain.transaction_signature AS registry_signature
       FROM work_record_feedback f JOIN wallet_users target ON target.id = f.target_user_id
       JOIN wallet_users reviewer ON reviewer.id = f.reviewer_user_id
       JOIN work_records wr ON wr.id = f.work_record_id
       LEFT JOIN registry_feedback_operations chain ON chain.feedback_id = f.id
      WHERE target.wallet_address = $1 AND ($2::timestamptz IS NULL OR f.created_at < $2)
      ORDER BY f.created_at DESC LIMIT $3`, [wallet, query.before ?? null, query.limit],
  );
  response.json({ data: result.rows });
});

registryRouter.get("/:wallet/charter-eligibility", async (request, response) => {
  const wallet = z.string().min(32).max(44).parse(request.params.wallet);
  response.json({ data: await charterEligibility(wallet) });
});

registryRouter.get("/:wallet", async (request, response) => {
  const wallet = z.string().min(32).max(44).parse(request.params.wallet);
  response.json({ data: await providerRecord(wallet) });
});
