import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { Connection } from "@solana/web3.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { loadCommissionEscrowSecretKey } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import type { PoolClient } from "pg";
import { enqueueWorkRecordChainOperation } from "./onchain-work-records.js";
import { loadSolanaFeePayer } from "./solana-fee-payer.js";

const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);

type Attempt = {
  id: string;
  transaction_signature: string;
  signed_transaction: Buffer;
  recent_blockhash: string;
  last_valid_block_height: string;
  state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

type SettlementResult = {
  commissionId: string;
  state: "submitted" | "confirmed";
  signature: string;
  destination: string;
  amountAtomic: string;
  feeAtomic: string;
  distribution: Record<string, string>;
};

function feeRecipients() {
  const values = [config.WORKER_FEE_WALLET, config.TREASURY_WALLET, config.STAKER_FEE_WALLET];
  if (values.some((value) => !value)) {
    throw new ApiError(503, "fee_wallets_unconfigured", "Commission fee recipient wallets are not configured.");
  }
  try {
    return values.map((value) => {
      const wallet = new PublicKey(value!);
      if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error("Fee recipient is not an EOA wallet.");
      return wallet.toBase58();
    });
  } catch {
    throw new ApiError(503, "fee_wallets_misconfigured", "A commission fee recipient must be a valid EOA wallet address.");
  }
}

export function commissionDistribution(grossAtomic: string, split = false, feeBasisPoints = 200n): { feeAtomic: string; distribution: Record<string, string> } {
  const gross = BigInt(grossAtomic);
  const fee = gross * feeBasisPoints / 10_000n;
  const workers = fee * 80n / 100n;
  const treasury = fee * 10n / 100n;
  const stakers = fee * 5n / 100n;
  const burn = fee - workers - treasury - stakers;
  const workerDistribution = {
    workers: workers.toString(),
    treasury: treasury.toString(),
    stakers: stakers.toString(),
    burn: burn.toString(),
  };
  return {
    feeAtomic: fee.toString(),
    distribution: split
      ? { ...workerDistribution, provider: ((gross - fee) / 2n).toString(), client: ((gross - fee) - (gross - fee) / 2n).toString() }
      : { ...workerDistribution, provider: (gross - fee).toString() },
  };
}

export type CrewShare = { userId: string; walletAddress: string; shareBps: number; payoutOrder: number; charterBuybackWallet: string | null };

async function loadCrewShares(client: PoolClient, commissionId: string): Promise<CrewShare[]> {
  const result = await client.query<{ user_id: string; wallet_address: string; share_bps: number; payout_order: number; charter_buyback_wallet: string | null }>(
    `SELECT s.user_id, s.wallet_address, s.share_bps, s.payout_order, c.vault_wallet_public_key AS charter_buyback_wallet
       FROM commission_payout_shares s LEFT JOIN charters c ON c.user_id = s.user_id AND c.state = 'active'
      WHERE s.commission_id = $1 ORDER BY s.payout_order`, [commissionId],
  );
  if (!result.rows.length || result.rows.reduce((sum, row) => sum + row.share_bps, 0) !== 10_000) {
    throw new ApiError(409, "crew_payout_shares_invalid", "Crew payout shares are missing or do not total 100 percent.");
  }
  return result.rows.map((row) => {
    let walletAddress: string;
    try { walletAddress = new PublicKey(row.wallet_address).toBase58(); }
    catch { throw new ApiError(409, "crew_payout_wallet_invalid", "A crew payout wallet address is invalid."); }
    return { userId: row.user_id, walletAddress, shareBps: row.share_bps, payoutOrder: row.payout_order,
      charterBuybackWallet: row.charter_buyback_wallet };
  });
}

export function allocateCrewAmount(totalAtomic: string, shares: CrewShare[]) {
  let remainder = BigInt(totalAtomic);
  return shares.map((share, index) => {
    const amount = index === shares.length - 1
      ? remainder
      : BigInt(totalAtomic) * BigInt(share.shareBps) / 10_000n;
    remainder -= amount;
    return { ...share, amountAtomic: amount.toString() };
  });
}

type CrewTransfer = { destination: string; amountAtomic: string; kind: "transfer" | "burn" };

export function crewTransferPlan(
  providerTotal: string,
  clientTotal: string | undefined,
  clientWallet: string,
  shares: CrewShare[],
  recipients: string[],
  distribution: Record<string, string>,
): CrewTransfer[] {
  const plan: CrewTransfer[] = [];
  for (const payout of allocateCrewAmount(providerTotal, shares)) {
    const buybackWallet = distribution[`crewBuybackWallet${payout.payoutOrder}`] ?? payout.charterBuybackWallet;
    const buybackAtomic = distribution[`crewBuybackAtomic${payout.payoutOrder}`];
    const buyback = buybackAtomic !== undefined ? BigInt(buybackAtomic)
      : buybackWallet ? BigInt(payout.amountAtomic) * BigInt(config.CHARTER_INCOME_BUYBACK_BPS) / 10_000n : 0n;
    plan.push({ destination: payout.walletAddress, amountAtomic: (BigInt(payout.amountAtomic) - buyback).toString(), kind: "transfer" });
    if (buyback > 0n && buybackWallet) {
      plan.push({ destination: buybackWallet, amountAtomic: buyback.toString(), kind: "transfer" });
    }
  }
  if (clientTotal) plan.push({ destination: clientWallet, amountAtomic: clientTotal, kind: "transfer" });
  plan.push({ destination: recipients[0]!, amountAtomic: distribution.workers!, kind: "transfer" });
  plan.push({ destination: recipients[1]!, amountAtomic: distribution.treasury!, kind: "transfer" });
  plan.push({ destination: recipients[2]!, amountAtomic: distribution.stakers!, kind: "transfer" });
  if (BigInt(distribution.burn!) > 0n) plan.push({ destination: "burn", amountAtomic: distribution.burn!, kind: "burn" });
  const total = plan.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
  if (total !== BigInt(providerTotal) + BigInt(clientTotal ?? "0")
    + BigInt(distribution.workers!) + BigInt(distribution.treasury!)
    + BigInt(distribution.stakers!) + BigInt(distribution.burn!)) {
    throw new ApiError(409, "crew_distribution_invalid", "Crew payouts do not balance with the commission escrow amount.");
  }
  return plan.filter((item) => BigInt(item.amountAtomic) > 0n);
}

async function prepareCrewChildOperations(
  client: PoolClient,
  commissionId: string,
  parentId: string,
  kind: "release" | "split",
  mint: string,
  plan: CrewTransfer[],
) {
  await client.query("BEGIN");
  try {
    for (const [index, item] of plan.entries()) await client.query(
      `INSERT INTO commission_escrow_operations
         (commission_id, parent_operation_id, operation_index, idempotency_key, operation, asset_kind,
          mint, amount_atomic, destination, state, fee_atomic, distribution)
       VALUES ($1, $2, $3, $4, $5, 'spl', $6, $7, $8, 'pending', 0, $9::jsonb)
       ON CONFLICT (commission_id, idempotency_key) DO NOTHING`,
      [commissionId, parentId, index + 1, `${kind}:${commissionId}:crew:${index + 1}`, kind,
        mint, item.amountAtomic, item.destination, JSON.stringify({ kind: item.kind })],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function submitCrewChildOperation(
  client: PoolClient,
  commissionId: string,
  operation: { id: string; destination: string; amount_atomic: string; mint: string; state: string; transaction_signature: string | null; distribution: Record<string, string> },
  escrowAddress: string,
): Promise<{ state: "confirmed" | "submitted"; attempt?: Attempt }> {
  if (operation.state === "confirmed") return { state: "confirmed" };
  let rows = await client.query<Attempt>(
    `SELECT id, transaction_signature, signed_transaction, recent_blockhash,
            last_valid_block_height::text, state FROM commission_escrow_operation_attempts
      WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
  );
  let attempt: Attempt | undefined = rows.rows[0];
  if (operation.state === "outcome_unknown") {
    if (!attempt) throw new ApiError(409, "crew_payout_outcome_unknown", "A prior Crew or Guild payout has an unknown Solana outcome and requires reconciliation before more escrow funds can move.");
    const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
    if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
      return { state: "confirmed", attempt: { ...attempt, state: "confirmed" } };
    }
    if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'failed', failure_code = 'chain_error', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'pending', failure_code = 'chain_error', updated_at = now() WHERE id = $1", [operation.id]);
      attempt = undefined;
    } else {
      throw new ApiError(409, "crew_payout_outcome_unknown", "A prior Crew or Guild payout has an unknown Solana outcome and requires reconciliation before more escrow funds can move.");
    }
  }
  if (attempt?.state === "confirmed") {
    await client.query("UPDATE commission_escrow_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
    return { state: "confirmed", attempt };
  }
  if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
    const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
    if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'pending', updated_at = now() WHERE id = $1", [operation.id]);
      attempt = undefined;
    } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
      return { state: "confirmed", attempt };
    } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
      await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
      return { state: "submitted", attempt };
    } else {
      // An expired blockhash only proves the signed transaction can no longer land;
      // a pruned RPC history does not prove that it did not already land.
      await client.query("UPDATE commission_escrow_operation_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
      await client.query("UPDATE commission_escrow_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [operation.id]);
      throw new ApiError(409, "crew_payout_outcome_unknown", "The payout transaction expired but its Solana outcome could not be verified. Reconcile this transfer before retrying the payout.");
    }
  }
  if (!attempt || ["failed", "expired"].includes(attempt.state)) {
    const feePayer = loadSolanaFeePayer();
    const mint = new PublicKey(operation.mint);
    const escrow = new PublicKey(escrowAddress);
    const source = getAssociatedTokenAddressSync(mint, escrow);
    const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
    if (!sourceInfo) throw new ApiError(409, "escrow_not_funded", "The crew commission escrow token account is missing.");
    const available = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
    if (available < BigInt(operation.amount_atomic)) throw new ApiError(409, "crew_escrow_balance_low", "The crew escrow has insufficient funds for the next payout.");
    const secret = await loadCommissionEscrowSecretKey(client, commissionId);
    const escrowKey = Keypair.fromSecretKey(secret);
    if (!escrowKey.publicKey.equals(escrow)) throw new Error("Decrypted crew escrow key does not match its recorded address.");
    const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
    const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest });
    if (operation.distribution.kind === "burn") {
      transaction.add(createBurnCheckedInstruction(source, mint, escrow, BigInt(operation.amount_atomic), 6, [], TOKEN_PROGRAM_ID));
    } else {
      const recipient = new PublicKey(operation.destination);
      const target = getAssociatedTokenAddressSync(mint, recipient);
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, target, recipient, mint),
        createTransferCheckedInstruction(source, mint, target, escrow, BigInt(operation.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
      );
    }
    transaction.partialSign(feePayer, escrowKey);
    if (!transaction.signature) throw new Error("Signed crew payout has no transaction signature.");
    const signature = bs58.encode(transaction.signature);
    const signed = transaction.serialize();
    const saved = await client.query<{ id: string }>(
      `INSERT INTO commission_escrow_operation_attempts
         (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
       VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
      [operation.id, signature, signed, latest.blockhash, latest.lastValidBlockHeight],
    );
    attempt = { id: saved.rows[0].id, transaction_signature: signature, signed_transaction: signed,
      recent_blockhash: latest.blockhash, last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
  }
  await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
  await client.query("UPDATE commission_escrow_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
  await client.query("UPDATE commission_escrow_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
  return { state: "submitted", attempt };
}

async function markConfirmed(
  attempt: Attempt,
  operationId: string,
  commissionId: string,
  providerUserId: string,
  kind: "release" | "refund" | "split",
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE commission_escrow_operation_attempts SET state = 'confirmed', updated_at = now()
       WHERE id = $1`, [attempt.id],
    );
    const operation = await client.query<{
      destination: string; amount_atomic: string; mint: string; fee_atomic: string;
      distribution: Record<string, string>;
    }>(
      `UPDATE commission_escrow_operations SET state = 'confirmed', updated_at = now()
       WHERE id = $1 RETURNING destination, amount_atomic, mint, fee_atomic, distribution`, [operationId],
    );
    const row = await client.query<{
      client_user_id: string;
      asset_mint: string;
      amount_atomic: string;
      status: string;
      work_type: string;
      provider_user_id: string | null;
      provider_agent_id: string | null;
    }>(
      "SELECT client_user_id, asset_mint, amount_atomic, status, work_type, provider_user_id, provider_agent_id FROM commissions WHERE id = $1 FOR UPDATE", [commissionId],
    );
    if (!row.rows[0]) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (!operation.rows[0]) throw new Error("Confirmed escrow operation was not found.");
    const expectedStatus = kind === "release" ? "approved" : kind === "refund" ? "refund_pending" : "split_pending";
    if (row.rows[0].status !== expectedStatus || (kind === "release" && row.rows[0].provider_user_id !== providerUserId)) {
      throw new ApiError(409, "commission_state_changed", "The approved commission changed before settlement finalized.");
    }
    if (kind === "release" || kind === "split") {
      const submission = await client.query<{ id: string }>(
        "SELECT id FROM commission_submissions WHERE commission_id = $1 ORDER BY revision DESC LIMIT 1", [commissionId],
      );
      const tribunal = await client.query<{ outcome: string | null }>(
        "SELECT outcome FROM tribunal_cases WHERE commission_id = $1 AND stage = 'decided'", [commissionId],
      );
      if (kind === "release" && !submission.rows[0] && !tribunal.rows[0]) {
        throw new Error("Cannot finalize an accepted work record without a submission.");
      }
      await client.query("UPDATE commissions SET status = 'complete', updated_at = now() WHERE id = $1 AND status = $2", [commissionId, expectedStatus]);
      const workOutcome = kind === "split" ? "tribunal_split" : tribunal.rows[0]?.outcome ? "tribunal_provider" : "accepted";
      await client.query(
        `INSERT INTO work_records
           (commission_id, client_user_id, provider_user_id, asset_mint, amount_atomic, paid_amount_atomic, final_submission_id, outcome, provider_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (commission_id) DO NOTHING`,
        [commissionId, row.rows[0].client_user_id, providerUserId, row.rows[0].asset_mint,
          row.rows[0].amount_atomic, operation.rows[0].distribution.provider,
          submission.rows[0]?.id ?? null, workOutcome, row.rows[0].provider_agent_id],
      );
      const record = await client.query<{ id: string }>("SELECT id FROM work_records WHERE commission_id = $1", [commissionId]);
      if (!record.rows[0]) throw new Error("Confirmed settlement has no work record.");
      if (["crew", "guild"].includes(row.rows[0].work_type)) {
        const shares = await loadCrewShares(client, commissionId);
        const payouts = allocateCrewAmount(operation.rows[0].distribution.provider, shares);
        for (const payout of payouts) await client.query(
          `INSERT INTO work_record_payouts (work_record_id, user_id, wallet_address, amount_atomic, share_bps)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (work_record_id, user_id) DO NOTHING`,
          [record.rows[0].id, payout.userId, payout.walletAddress, payout.amountAtomic, payout.shareBps],
        );
      }
      for (const [key, value] of Object.entries(operation.rows[0].distribution)) {
        const match = /^crewBuybackUserId(\d+)$/.exec(key);
        if (match && BigInt(operation.rows[0].distribution[`crewBuybackAtomic${match[1]}`] ?? "0") > 0n) {
          await client.query(
            `INSERT INTO charter_buybacks (user_id, work_record_id, asset_mint, amount_atomic)
             VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, work_record_id) DO NOTHING`,
            [value, record.rows[0].id, row.rows[0].asset_mint, operation.rows[0].distribution[`crewBuybackAtomic${match[1]}`]],
          );
        }
      }
      if (operation.rows[0].distribution.charterBuybackUserId
        && BigInt(operation.rows[0].distribution.charterBuybackAtomic ?? "0") > 0n) {
        await client.query(
          `INSERT INTO charter_buybacks (user_id, work_record_id, asset_mint, amount_atomic)
           VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, work_record_id) DO NOTHING`,
          [operation.rows[0].distribution.charterBuybackUserId, record.rows[0].id, row.rows[0].asset_mint,
            operation.rows[0].distribution.charterBuybackAtomic],
        );
      }
      await enqueueWorkRecordChainOperation(client, record.rows[0].id);
    } else {
      await client.query("UPDATE commissions SET status = 'refunded', updated_at = now() WHERE id = $1 AND status = 'refund_pending'", [commissionId]);
      await client.query("UPDATE bounty_evaluator_assignments SET released_at = now() WHERE commission_id = $1 AND released_at IS NULL", [commissionId]);
      const tribunal = await client.query<{ outcome: string | null }>(
        "SELECT outcome FROM tribunal_cases WHERE commission_id = $1 AND stage = 'decided'", [commissionId],
      );
      if (tribunal.rows[0]?.outcome === "client" && row.rows[0].provider_user_id) {
        const submission = await client.query<{ id: string }>(
          "SELECT id FROM commission_submissions WHERE commission_id = $1 ORDER BY revision DESC LIMIT 1", [commissionId],
        );
        await client.query(
          `INSERT INTO work_records
             (commission_id, client_user_id, provider_user_id, asset_mint, amount_atomic, paid_amount_atomic, final_submission_id, outcome)
           VALUES ($1, $2, $3, $4, $5, 0, $6, 'tribunal_client') ON CONFLICT (commission_id) DO NOTHING`,
          [commissionId, row.rows[0].client_user_id, row.rows[0].provider_user_id, row.rows[0].asset_mint,
            row.rows[0].amount_atomic, submission.rows[0]?.id ?? null],
        );
        const record = await client.query<{ id: string }>("SELECT id FROM work_records WHERE commission_id = $1", [commissionId]);
        if (!record.rows[0]) throw new Error("Confirmed Tribunal refund has no work record.");
        if (["crew", "guild"].includes(row.rows[0].work_type)) {
          const shares = await loadCrewShares(client, commissionId);
          for (const share of shares) await client.query(
            `INSERT INTO work_record_payouts (work_record_id, user_id, wallet_address, amount_atomic, share_bps)
             VALUES ($1, $2, $3, 0, $4) ON CONFLICT (work_record_id, user_id) DO NOTHING`,
            [record.rows[0].id, share.userId, share.walletAddress, share.shareBps],
          );
        }
        await enqueueWorkRecordChainOperation(client, record.rows[0].id);
      }
    }
    await client.query("COMMIT");
    return operation.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Finalize DB records for a payout whose exact signature is already finalized on Solana.
 * This recovery path never broadcasts or replaces a settlement transaction.
 */
export async function syncFinalizedCommissionSettlement(commissionId: string, signature: string) {
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || status.confirmationStatus !== "finalized") {
    throw new ApiError(409, "settlement_not_finalized", "The exact settlement signature is not finalized on Solana.");
  }

  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [commissionId]);
    lockHeld = true;
    const result = await client.query<{
      status: string; provider_user_id: string | null; operation_id: string; operation_state: string;
      attempt_id: string; transaction_signature: string; signed_transaction: Buffer;
      recent_blockhash: string; last_valid_block_height: string; attempt_state: Attempt["state"];
    }>(
      `SELECT c.status, c.provider_user_id, o.id AS operation_id, o.state AS operation_state,
              a.id AS attempt_id, a.transaction_signature, a.signed_transaction, a.recent_blockhash,
              a.last_valid_block_height::text, a.state AS attempt_state
         FROM commissions c
         JOIN commission_escrow_operations o ON o.commission_id = c.id AND o.operation = 'release'
         JOIN commission_escrow_operation_attempts a ON a.operation_id = o.id
        WHERE c.id = $1 AND a.transaction_signature = $2
        ORDER BY a.created_at DESC LIMIT 1`, [commissionId, signature],
    );
    const row = result.rows[0];
    if (!row || row.status !== "approved" || !row.provider_user_id
      || !["submitted", "outcome_unknown"].includes(row.operation_state)
      || !["submitted", "outcome_unknown"].includes(row.attempt_state)) {
      throw new ApiError(409, "settlement_state_changed", "The commission records no longer match this finalized settlement.");
    }
    const attempt: Attempt = {
      id: row.attempt_id,
      transaction_signature: row.transaction_signature,
      signed_transaction: row.signed_transaction,
      recent_blockhash: row.recent_blockhash,
      last_valid_block_height: row.last_valid_block_height,
      state: row.attempt_state,
    };
    await markConfirmed(attempt, row.operation_id, commissionId, row.provider_user_id, "release");
    return { commissionId, state: "confirmed" as const, signature };
  } finally {
    if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [commissionId]).catch(() => undefined);
    client.release();
  }
}

async function settleCrewPayoutSteps(
  db: PoolClient,
  commission: { id: string; amount_atomic: string; asset_mint: string; client_wallet: string; escrow_address: string; provider_user_id: string | null },
  parent: { id: string; fee_atomic: string; distribution: Record<string, string> },
  kind: "release" | "split",
  destination: string,
  distribution: Record<string, string>,
  shares: CrewShare[],
  recipients: string[],
): Promise<SettlementResult> {
  let childRows = await db.query<{
    id: string; destination: string; amount_atomic: string; mint: string; state: string;
    transaction_signature: string | null; distribution: Record<string, string>;
  }>(
    `SELECT id, destination, amount_atomic, mint, state, transaction_signature, distribution
       FROM commission_escrow_operations WHERE parent_operation_id = $1 ORDER BY operation_index`, [parent.id],
  );
  if (!childRows.rows.length) {
    const mint = new PublicKey(commission.asset_mint);
    const escrow = new PublicKey(commission.escrow_address);
    const source = getAssociatedTokenAddressSync(mint, escrow);
    const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
    if (!sourceInfo) throw new ApiError(409, "escrow_not_funded", "The crew commission escrow token account is missing.");
    const initialBalance = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
    if (initialBalance < BigInt(commission.amount_atomic)) throw new ApiError(409, "escrow_balance_low", "The crew commission escrow does not hold the complete funded amount.");
    const plan = crewTransferPlan(distribution.provider!, distribution.client, commission.client_wallet, shares, recipients, distribution);
    if (!plan.length) throw new Error("Crew settlement produced an empty payout plan.");
    await prepareCrewChildOperations(db, commission.id, parent.id, kind, commission.asset_mint, plan);
    childRows = await db.query(
      `SELECT id, destination, amount_atomic, mint, state, transaction_signature, distribution
         FROM commission_escrow_operations WHERE parent_operation_id = $1 ORDER BY operation_index`, [parent.id],
    );
  }
  for (const child of childRows.rows) {
    if (child.state === "confirmed") continue;
    const result = await submitCrewChildOperation(db, commission.id, child, commission.escrow_address);
    if (result.state === "submitted") return {
      commissionId: commission.id, state: "submitted", signature: result.attempt!.transaction_signature,
      destination, amountAtomic: commission.amount_atomic,
      feeAtomic: parent.fee_atomic, distribution: parent.distribution,
    };
  }
  const lastAttempt = await db.query<Attempt>(
    `SELECT a.id, a.transaction_signature, a.signed_transaction, a.recent_blockhash,
            a.last_valid_block_height::text, a.state
       FROM commission_escrow_operation_attempts a JOIN commission_escrow_operations o ON o.id = a.operation_id
      WHERE o.parent_operation_id = $1 AND a.state = 'confirmed' ORDER BY a.created_at DESC LIMIT 1`, [parent.id],
  );
  if (!lastAttempt.rows[0]) throw new Error("Crew settlement has no confirmed transfer attempt.");
  await markConfirmed(lastAttempt.rows[0], parent.id, commission.id, commission.provider_user_id ?? "", kind);
  return {
    commissionId: commission.id, state: "confirmed", signature: lastAttempt.rows[0].transaction_signature,
    destination, amountAtomic: commission.amount_atomic,
    feeAtomic: parent.fee_atomic, distribution: parent.distribution,
  };
}

export async function settleCommission(commissionId: string, kind: "release" | "refund" | "split"): Promise<SettlementResult> {
  const connectionClient = await pool.connect();
  let lockHeld = false;
  try {
    await connectionClient.query("SELECT pg_advisory_lock(hashtext($1))", [commissionId]);
    lockHeld = true;
    const commissionResult = await connectionClient.query<{
      id: string;
      status: string;
      work_type: string;
      asset_mint: string;
      amount_atomic: string;
      provider_wallet: string | null;
      provider_user_id: string | null;
      client_wallet: string;
      deadline_at: Date;
      escrow_address: string;
    }>(
      `SELECT c.id, c.status, c.work_type, c.asset_mint, c.amount_atomic, c.provider_wallet, c.provider_user_id,
              c.client_wallet, c.deadline_at,
              w.public_key AS escrow_address
       FROM commissions c JOIN commission_escrow_wallets w ON w.commission_id = c.id
       WHERE c.id = $1`, [commissionId],
    );
    const commission = commissionResult.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    const finalStatus = kind === "refund" ? "refunded" : "complete";
    if (commission.status === finalStatus) {
      const completed = await connectionClient.query<{
        transaction_signature: string; destination: string; amount_atomic: string;
        fee_atomic: string; distribution: Record<string, string>;
      }>(
        `SELECT transaction_signature, destination, amount_atomic, fee_atomic, distribution FROM commission_escrow_operations
         WHERE commission_id = $1 AND operation = $2 AND state = 'confirmed'`, [commissionId, kind],
      );
      if (completed.rows[0]?.transaction_signature) return {
        commissionId, state: "confirmed", signature: completed.rows[0].transaction_signature,
        destination: completed.rows[0].destination, amountAtomic: completed.rows[0].amount_atomic,
        feeAtomic: completed.rows[0].fee_atomic, distribution: completed.rows[0].distribution,
      };
      throw new ApiError(409, "settlement_record_missing", "The final commission state has no matching confirmed escrow operation.");
    }
    if (kind === "release" && commission.status !== "approved") throw new ApiError(409, "commission_not_approved", "The client must approve a submission before settlement.");
    if (kind === "refund") {
      const tribunalRefund = await connectionClient.query(
        "SELECT 1 FROM tribunal_cases WHERE commission_id = $1 AND stage = 'decided' AND outcome = 'client'", [commissionId],
      );
      const expiredRefund = commission.deadline_at <= new Date()
        && ["funded", "submitted", "refund_pending"].includes(commission.status);
      if (!tribunalRefund.rowCount && !expiredRefund) {
        throw new ApiError(409, "commission_not_expired", "This commission is not eligible for an expiry refund.");
      }
      if (!tribunalRefund.rowCount && commission.work_type === "bounty") {
        const submittedEntry = await connectionClient.query(
          "SELECT 1 FROM bounty_entries WHERE commission_id = $1 AND submitted_at <= $2 LIMIT 1",
          [commissionId, commission.deadline_at],
        );
        if (submittedEntry.rowCount) throw new ApiError(409, "bounty_entries_pending_evaluation", "An on-time bounty entry is awaiting evaluator ranking.");
      }
      if (commission.work_type === "bounty") {
        const unexpiredBond = await connectionClient.query<{ bond_last_valid_block_height: string }>(
          `SELECT bond_last_valid_block_height::text FROM bounty_entries
            WHERE commission_id = $1 AND bond_signature IS NULL AND bond_last_valid_block_height IS NOT NULL`, [commissionId],
        );
        if (unexpiredBond.rows.length) {
          const currentHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
          if (unexpiredBond.rows.some((entry) => currentHeight <= Number(entry.bond_last_valid_block_height))) {
            throw new ApiError(409, "bounty_bond_transactions_pending", "Wait for all entrant bond transactions to confirm or expire before refunding the bounty.");
          }
        }
      }
      if (commission.status !== "refund_pending") {
        if (!tribunalRefund.rowCount && !["funded", "submitted"].includes(commission.status)) {
          throw new ApiError(409, "commission_not_refundable", "This commission cannot be refunded in its current state.");
        }
        if (!tribunalRefund.rowCount) {
        const onTimeSubmission = await connectionClient.query(
          "SELECT 1 FROM commission_submissions WHERE commission_id = $1 AND submitted_at <= $2 LIMIT 1",
          [commissionId, commission.deadline_at],
        );
        if (onTimeSubmission.rowCount) throw new ApiError(409, "commission_submitted_on_time", "An on-time submission is awaiting review and cannot be refunded as expired.");
        }
        await connectionClient.query("UPDATE commissions SET status = 'refund_pending', updated_at = now() WHERE id = $1", [commissionId]);
      }
    }
    if (kind === "release" && (!commission.provider_wallet || !commission.provider_user_id)) {
      throw new ApiError(409, "provider_missing", "The commission has no assigned provider.");
    }
    if (kind === "split" && (!commission.provider_wallet || !commission.provider_user_id || commission.status !== "split_pending")) {
      throw new ApiError(409, "split_not_available", "A split Tribunal ruling and assigned provider are required for this settlement.");
    }

    const feePayer = loadSolanaFeePayer();
    const recipients = kind !== "refund" ? feeRecipients() : [];
    const feeBasisPoints = ["hand", "bounty"].includes(commission.work_type)
      ? 500n : commission.work_type === "interop" ? 100n : 200n;
    const calculated = kind === "release" || kind === "split"
      ? commissionDistribution(commission.amount_atomic, kind === "split", feeBasisPoints)
      : { feeAtomic: "0", distribution: { client: commission.amount_atomic } };
    const feeAtomic = calculated.feeAtomic;
    const distribution: Record<string, string> = { ...calculated.distribution };
    const crewShares = kind !== "refund" && ["crew", "guild"].includes(commission.work_type)
      ? await loadCrewShares(connectionClient, commissionId) : [];
    if (crewShares.length) {
      for (const payout of allocateCrewAmount(distribution.provider!, crewShares)) {
        distribution[`crewWallet${payout.payoutOrder}`] = payout.walletAddress;
        distribution[`crewAmount${payout.payoutOrder}`] = payout.amountAtomic;
        if (payout.charterBuybackWallet) {
          distribution[`crewBuybackWallet${payout.payoutOrder}`] = payout.charterBuybackWallet;
          distribution[`crewBuybackUserId${payout.payoutOrder}`] = payout.userId;
          distribution[`crewBuybackAtomic${payout.payoutOrder}`] =
            (BigInt(payout.amountAtomic) * BigInt(config.CHARTER_INCOME_BUYBACK_BPS) / 10_000n).toString();
        }
      }
    } else if ((kind === "release" || kind === "split") && commission.provider_user_id) {
      const charter = await connectionClient.query<{ wallet: string }>(
        "SELECT vault_wallet_public_key AS wallet FROM charters WHERE user_id = $1 AND state = 'active'",
        [commission.provider_user_id],
      );
      if (charter.rows[0]) {
        const payout = BigInt(distribution.provider!);
        distribution.charterBuybackWallet = charter.rows[0].wallet;
        distribution.charterBuybackUserId = commission.provider_user_id;
        distribution.charterBuybackAtomic = (payout * BigInt(config.CHARTER_INCOME_BUYBACK_BPS) / 10_000n).toString();
      }
    }
    if (kind !== "refund") {
      distribution.feeWorkerWallet = recipients[0]!;
      distribution.feeTreasuryWallet = recipients[1]!;
      distribution.feeStakerWallet = recipients[2]!;
    }
    const destination = kind === "release" ? ["crew", "guild"].includes(commission.work_type) ? `${commission.work_type}:${commissionId}` : commission.provider_wallet!
      : kind === "refund" ? commission.client_wallet : `split:${commission.client_wallet}:${commission.provider_wallet}`;
    const operationKey = `${kind}:${commissionId}`;
    const inserted = await connectionClient.query<{ id: string }>(
      `INSERT INTO commission_escrow_operations
         (commission_id, idempotency_key, operation, asset_kind, mint, amount_atomic, destination, state, fee_atomic, distribution)
       VALUES ($1, $2, $3, 'spl', $4, $5, $6, 'pending', $7, $8::jsonb)
       ON CONFLICT (commission_id, idempotency_key) DO NOTHING RETURNING id`,
      [commissionId, operationKey, kind, commission.asset_mint, commission.amount_atomic, destination,
        feeAtomic, JSON.stringify(distribution)],
    );
    const operationResult = await connectionClient.query<{
      id: string; state: string; transaction_signature: string | null;
      fee_atomic: string; distribution: Record<string, string>;
    }>(
      `SELECT id, state, transaction_signature, fee_atomic, distribution FROM commission_escrow_operations
       WHERE commission_id = $1 AND idempotency_key = $2 FOR UPDATE`, [commissionId, operationKey],
    );
    const operation = operationResult.rows[0];
    if (!operation) throw new Error("Could not create or load the commission release operation.");
    if (operation.state === "confirmed" && operation.transaction_signature) {
      return { commissionId, state: "confirmed", signature: operation.transaction_signature,
        destination, amountAtomic: commission.amount_atomic,
        feeAtomic: operation.fee_atomic, distribution: operation.distribution };
    }

    if ((kind === "release" || kind === "split") && ["crew", "guild"].includes(commission.work_type)) {
      const stableRecipients = [operation.distribution.feeWorkerWallet, operation.distribution.feeTreasuryWallet,
        operation.distribution.feeStakerWallet].every(Boolean)
        ? [operation.distribution.feeWorkerWallet!, operation.distribution.feeTreasuryWallet!, operation.distribution.feeStakerWallet!]
        : recipients;
      return await settleCrewPayoutSteps(connectionClient, commission, operation, kind,
        destination, operation.distribution, crewShares, stableRecipients);
    }

    let attemptResult = await connectionClient.query<Attempt>(
      `SELECT id, transaction_signature, signed_transaction, recent_blockhash,
              last_valid_block_height::text, state
       FROM commission_escrow_operation_attempts WHERE operation_id = $1
       ORDER BY created_at DESC LIMIT 1`, [operation.id],
    );
    let attempt: Attempt | undefined = attemptResult.rows[0];
    if (attempt?.state === "outcome_unknown") {
      const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        const confirmed = await markConfirmed(attempt, operation.id, commissionId, commission.provider_user_id ?? "", kind);
        return { commissionId, state: "confirmed", signature: attempt.transaction_signature,
          destination: confirmed.destination, amountAtomic: confirmed.amount_atomic,
          feeAtomic: operation.fee_atomic, distribution: operation.distribution };
      }
      if (status?.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await connectionClient.query(
          `UPDATE commission_escrow_operation_attempts SET state = 'failed', failure_code = 'chain_error', updated_at = now()
           WHERE id = $1`, [attempt.id],
        );
        await connectionClient.query(
          "UPDATE commission_escrow_operations SET state = 'pending', failure_code = 'chain_error', updated_at = now() WHERE id = $1",
          [operation.id],
        );
        attempt = undefined;
      } else {
        throw new ApiError(409, "settlement_outcome_unknown", "The escrow transfer still has no verifiable Solana result. The same transaction will be checked again before any replacement is prepared.");
      }
    }
    if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
      const statusResult = await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true });
      const status = statusResult.value[0];
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await connectionClient.query(
          `UPDATE commission_escrow_operation_attempts SET state = 'failed', failure_code = 'chain_error', updated_at = now()
           WHERE id = $1`, [attempt.id],
        );
        await connectionClient.query(
          "UPDATE commission_escrow_operations SET state = 'pending', failure_code = 'chain_error', updated_at = now() WHERE id = $1",
          [operation.id],
        );
        attempt = undefined;
      } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        const confirmed = await markConfirmed(attempt, operation.id, commissionId, commission.provider_user_id ?? "", kind);
        return { commissionId, state: "confirmed", signature: attempt.transaction_signature,
          destination: confirmed.destination, amountAtomic: confirmed.amount_atomic,
          feeAtomic: operation.fee_atomic, distribution: operation.distribution };
      } else {
        const currentHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
        if (currentHeight <= Number(attempt.last_valid_block_height)) {
          await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
          await connectionClient.query(
            `UPDATE commission_escrow_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1`, [attempt.id],
          );
          await connectionClient.query(
            `UPDATE commission_escrow_operations SET state = 'submitted', transaction_signature = $2, updated_at = now()
             WHERE id = $1`, [operation.id, attempt.transaction_signature],
          );
          return { commissionId, state: "submitted", signature: attempt.transaction_signature,
            destination, amountAtomic: commission.amount_atomic,
            feeAtomic: operation.fee_atomic, distribution: operation.distribution };
        }
        await connectionClient.query(
          "UPDATE commission_escrow_operation_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id],
        );
        await connectionClient.query(
          "UPDATE commission_escrow_operations SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [operation.id],
        );
        throw new ApiError(409, "settlement_outcome_unknown", "The escrow transfer expired without a verifiable Solana result. The same transaction will be checked again before any replacement is prepared.");
      }
    }

    if (!attempt || ["failed", "expired"].includes(attempt.state)) {
      const mint = new PublicKey(commission.asset_mint);
      const escrow = new PublicKey(commission.escrow_address);
      const sourceTokenAccount = getAssociatedTokenAddressSync(mint, escrow);
      const sourceAccount = await connection.getAccountInfo(sourceTokenAccount, config.SOLANA_COMMITMENT);
      if (!sourceAccount) throw new ApiError(409, "escrow_not_funded", "The commission escrow token account is missing.");
      const balance = await connection.getTokenAccountBalance(sourceTokenAccount, config.SOLANA_COMMITMENT);
      if (BigInt(balance.value.amount) < BigInt(commission.amount_atomic)) {
        throw new ApiError(409, "escrow_balance_low", "The commission escrow does not hold the approved amount.");
      }
      const escrowSecret = await loadCommissionEscrowSecretKey(connectionClient, commissionId);
      const escrowKeypair = Keypair.fromSecretKey(escrowSecret);
      if (!escrowKeypair.publicKey.equals(escrow)) throw new Error("Decrypted escrow key does not match its recorded public key.");
      const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latestBlockhash });
      const addTransfer = (owner: PublicKey, amount: string) => {
        if (BigInt(amount) === 0n) return;
        const tokenAccount = getAssociatedTokenAddressSync(mint, owner);
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, tokenAccount, owner, mint),
          createTransferCheckedInstruction(
            sourceTokenAccount, mint, tokenAccount, escrow, BigInt(amount), 6, [], TOKEN_PROGRAM_ID,
          ),
        );
      };
      const addProviderPayout = (providerAmount: string) => {
        if (["crew", "guild"].includes(commission.work_type)) {
          for (const payout of allocateCrewAmount(providerAmount, crewShares)) {
            addTransfer(new PublicKey(payout.walletAddress), payout.amountAtomic);
          }
        } else {
          const reserve = BigInt(operation.distribution.charterBuybackAtomic ?? "0");
          addTransfer(new PublicKey(commission.provider_wallet!), (BigInt(providerAmount) - reserve).toString());
          if (reserve > 0n && operation.distribution.charterBuybackWallet) {
            addTransfer(new PublicKey(operation.distribution.charterBuybackWallet), reserve.toString());
          }
        }
      };
      if (kind === "release" || kind === "split") {
        if (kind === "split") {
          const splitDistribution = commissionDistribution(commission.amount_atomic, true, feeBasisPoints).distribution;
          addProviderPayout(splitDistribution.provider);
          addTransfer(new PublicKey(commission.client_wallet), splitDistribution.client);
        } else {
          const releaseDistribution = commissionDistribution(commission.amount_atomic, false, feeBasisPoints).distribution;
          addProviderPayout(releaseDistribution.provider);
        }
        const releaseDistribution = commissionDistribution(commission.amount_atomic, false, feeBasisPoints).distribution;
        addTransfer(new PublicKey(recipients[0]!), releaseDistribution.workers);
        addTransfer(new PublicKey(recipients[1]!), releaseDistribution.treasury);
        addTransfer(new PublicKey(recipients[2]!), releaseDistribution.stakers);
        if (BigInt(releaseDistribution.burn) > 0n) {
          transaction.add(createBurnCheckedInstruction(
            sourceTokenAccount, mint, escrow, BigInt(releaseDistribution.burn), 6, [], TOKEN_PROGRAM_ID,
          ));
        }
      } else {
        addTransfer(new PublicKey(commission.client_wallet), commission.amount_atomic);
      }
      transaction.partialSign(feePayer, escrowKeypair);
      const signedTransaction = transaction.serialize();
      if (!transaction.signature) throw new Error("Signed commission transaction has no signature.");
      const transactionSignature = bs58.encode(transaction.signature);
      const saved = await connectionClient.query<{ id: string }>(
        `INSERT INTO commission_escrow_operation_attempts
           (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
        [operation.id, transactionSignature, signedTransaction, latestBlockhash.blockhash, latestBlockhash.lastValidBlockHeight],
      );
      attempt = {
        id: saved.rows[0].id, transaction_signature: transactionSignature,
        signed_transaction: signedTransaction, recent_blockhash: latestBlockhash.blockhash,
        last_valid_block_height: String(latestBlockhash.lastValidBlockHeight), state: "prepared",
      };
    }

    await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await connectionClient.query(
      `UPDATE commission_escrow_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1`, [attempt.id],
    );
    await connectionClient.query(
      `UPDATE commission_escrow_operations SET state = 'submitted', transaction_signature = $2, failure_code = NULL, updated_at = now()
       WHERE id = $1`, [operation.id, attempt.transaction_signature],
    );
    return { commissionId, state: "submitted", signature: attempt.transaction_signature,
      destination, amountAtomic: commission.amount_atomic,
      feeAtomic: operation.fee_atomic, distribution: operation.distribution };
  } finally {
    if (lockHeld) await connectionClient.query("SELECT pg_advisory_unlock(hashtext($1))", [commissionId]).catch(() => undefined);
    connectionClient.release();
  }
}

export async function reconcileCommissionSettlements(limit = 25) {
  const due = await pool.query<{ commission_id: string }>(
    `SELECT DISTINCT o.commission_id
       FROM commission_escrow_operations o
       JOIN commissions c ON c.id = o.commission_id
      WHERE o.operation IN ('release', 'refund', 'split') AND o.state IN ('pending', 'submitted', 'outcome_unknown')
        AND ((o.operation = 'release' AND c.status = 'approved')
          OR (o.operation = 'refund' AND c.status = 'refund_pending')
          OR (o.operation = 'split' AND c.status = 'split_pending'))
      ORDER BY o.commission_id LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { commissionId: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const operation = await pool.query<{ operation: "release" | "refund" | "split" }>(
        "SELECT operation FROM commission_escrow_operations WHERE commission_id = $1 AND state IN ('pending', 'submitted') ORDER BY created_at DESC LIMIT 1",
        [row.commission_id],
      );
      const result = await settleCommission(row.commission_id, operation.rows[0]?.operation ?? "release");
      if (result.state === "confirmed") confirmed += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({
        commissionId: row.commission_id,
        code: error instanceof ApiError ? error.code : "reconciliation_error",
      });
    }
  }
  return { examined: due.rowCount ?? due.rows.length, confirmed, submitted, errors };
}

export async function settleDecidedTribunalCases(limit = 25) {
  const due = await pool.query<{ commission_id: string; kind: "release" | "refund" | "split" }>(
    `SELECT c.id AS commission_id,
            CASE WHEN tc.outcome = 'client' THEN 'refund'
                 WHEN tc.outcome = 'split' THEN 'split' ELSE 'release' END AS kind
       FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
      WHERE tc.stage = 'decided' AND c.status IN ('approved', 'refund_pending', 'split_pending')
      ORDER BY tc.decided_at LIMIT $1`, [limit],
  );
  let confirmed = 0;
  let submitted = 0;
  const errors: { commissionId: string; code: string }[] = [];
  for (const row of due.rows) {
    try {
      const result = await settleCommission(row.commission_id, row.kind);
      if (result.state === "confirmed") confirmed += 1;
      else submitted += 1;
    } catch (error) {
      errors.push({ commissionId: row.commission_id, code: error instanceof ApiError ? error.code : "settlement_error" });
    }
  }
  return { examined: due.rows.length, confirmed, submitted, errors };
}
