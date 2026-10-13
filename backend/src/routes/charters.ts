import { Router } from "express";
import {
  AuthorityType, ExtensionType, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createInitializeTransferFeeConfigInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  createInitializeMint2Instruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getTransferFeeAmount,
  getTransferFeeConfig,
  getMintLen,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { decryptSolanaSecretKey, createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { loadSolanaFeePayer } from "../solana-fee-payer.js";
import { validateJupiterSwapOrder, type JupiterSwapOrder } from "../jupiter-order.js";
import { charterEligibility } from "./registry.js";
import { tokenOwnerBalanceDelta } from "../solana-token-balance.js";

export const chartersRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const decimals = 9;
const atomicPerToken = 1_000_000_000n;
const charterTransferFeeBps = 100;
// With 70/30 payouts and a 1% fee rounded up, both transfers must be at least 100 atomic units.
const minimumCharterFeeDistributionAtomic = 334n;

type CharterRow = {
  user_id: string; token_mint: string; vault_wallet_public_key: string;
  encrypted_vault_secret_key: Buffer; vault_encryption_nonce: Buffer;
  vault_encryption_auth_tag: Buffer; vault_encryption_key_version: number;
  liquidity_wallet_public_key: string; encrypted_liquidity_secret_key: Buffer;
  liquidity_encryption_nonce: Buffer; liquidity_encryption_auth_tag: Buffer;
  liquidity_encryption_key_version: number;
  fee_wallet_public_key: string | null; encrypted_fee_secret_key: Buffer | null;
  fee_encryption_nonce: Buffer | null; fee_encryption_auth_tag: Buffer | null;
  fee_encryption_key_version: number | null;
  cluster: string; supply_atomic: string; creator_allocation_atomic: string;
  liquidity_allocation_atomic: string; creator_vesting_weeks: number;
  liquidity_unlock_at: Date | null; state: string; launched_at: Date | null;
  creator_tokens_released_atomic: string;
};

function supplyAtomic() { return config.CHARTER_TOTAL_SUPPLY_TOKENS * atomicPerToken; }

function buildLaunchTransaction(input: { mint: Keypair; vault: Keypair; liquidityVault: Keypair; feeWallet: PublicKey; supply: bigint; creatorAllocation: bigint; liquidityAllocation: bigint; mintSpace: number; rentLamports: number; feePayer: Keypair }) {
  const tokenMint = input.mint.publicKey;
  const vaultWallet = input.vault.publicKey;
  const liquidityWallet = input.liquidityVault.publicKey;
  const vaultAta = getAssociatedTokenAddressSync(tokenMint, vaultWallet, false, TOKEN_2022_PROGRAM_ID);
  const liquidityAta = getAssociatedTokenAddressSync(tokenMint, liquidityWallet, false, TOKEN_2022_PROGRAM_ID);
  const transaction = new Transaction({ feePayer: input.feePayer.publicKey });
  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: input.feePayer.publicKey,
      newAccountPubkey: tokenMint,
      lamports: input.rentLamports,
      space: input.mintSpace,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(tokenMint, null, input.feeWallet,
      charterTransferFeeBps, input.supply, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(tokenMint, decimals, vaultWallet, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(
      input.feePayer.publicKey, vaultAta, vaultWallet, tokenMint, TOKEN_2022_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      input.feePayer.publicKey, liquidityAta, liquidityWallet, tokenMint, TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(tokenMint, vaultAta, vaultWallet, input.supply, decimals, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(vaultAta, tokenMint, liquidityAta, vaultWallet, input.liquidityAllocation, decimals, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(tokenMint, vaultWallet, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  if (input.creatorAllocation + input.liquidityAllocation !== input.supply) throw new Error("Charter token allocations do not equal the fixed supply.");
  return transaction;
}

async function prepareLaunchAttempt(charter: CharterRow, mint = Keypair.generate()) {
  const vault = Keypair.fromSecretKey(decryptSolanaSecretKey({
    ciphertext: charter.encrypted_vault_secret_key,
    nonce: charter.vault_encryption_nonce,
    authTag: charter.vault_encryption_auth_tag,
    keyVersion: charter.vault_encryption_key_version,
  }));
  if (vault.publicKey.toBase58() !== charter.vault_wallet_public_key) throw new Error("Charter vault key does not match its recorded address.");
  const liquidityVault = Keypair.fromSecretKey(decryptSolanaSecretKey({
    ciphertext: charter.encrypted_liquidity_secret_key,
    nonce: charter.liquidity_encryption_nonce,
    authTag: charter.liquidity_encryption_auth_tag,
    keyVersion: charter.liquidity_encryption_key_version,
  }));
  if (liquidityVault.publicKey.toBase58() !== charter.liquidity_wallet_public_key) throw new Error("Charter liquidity vault key does not match its recorded address.");
  if (!charter.fee_wallet_public_key) throw new Error("Charter transfer-fee wallet is not configured.");
  const payer = loadSolanaFeePayer();
  const mintSpace = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await connection.getMinimumBalanceForRentExemption(mintSpace, config.SOLANA_COMMITMENT);
  const transaction = buildLaunchTransaction({
    mint, vault, liquidityVault, feeWallet: new PublicKey(charter.fee_wallet_public_key), supply: BigInt(charter.supply_atomic),
    creatorAllocation: BigInt(charter.creator_allocation_atomic), liquidityAllocation: BigInt(charter.liquidity_allocation_atomic),
    mintSpace, rentLamports: rent, feePayer: payer,
  });
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  transaction.recentBlockhash = latest.blockhash;
  transaction.partialSign(payer, mint, vault);
  if (!transaction.signature) throw new Error("Signed Charter launch has no transaction signature.");
  return {
    mint: mint.publicKey.toBase58(),
    signature: bs58.encode(transaction.signature),
    signedTransaction: transaction.serialize(),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

async function launchState(userId: string) {
  const result = await pool.query<CharterRow & {
    launch_state: string | null; transaction_signature: string | null;
    vesting_weeks_claimed: string; buyback_amount_atomic: string;
  }>(
    `SELECT c.user_id, c.token_mint, c.vault_wallet_public_key,
            c.liquidity_wallet_public_key, c.fee_wallet_public_key,
            c.cluster, c.supply_atomic::text, c.creator_allocation_atomic::text,
            c.liquidity_allocation_atomic::text, c.creator_vesting_weeks, c.liquidity_unlock_at,
            c.state, c.launched_at, c.creator_tokens_released_atomic::text,
            op.state AS launch_state, attempt.transaction_signature,
            (SELECT count(*)::text FROM charter_vesting_weeks w WHERE w.user_id = c.user_id AND w.claimed_amount_atomic > 0) AS vesting_weeks_claimed,
            COALESCE((SELECT sum(b.amount_atomic)::text FROM charter_buybacks b WHERE b.user_id = c.user_id), '0') AS buyback_amount_atomic
       FROM charters c LEFT JOIN charter_launch_operations op ON op.user_id = c.user_id
       LEFT JOIN LATERAL (SELECT transaction_signature FROM charter_launch_attempts a WHERE a.operation_id = op.id ORDER BY a.created_at DESC LIMIT 1) attempt ON true
      WHERE c.user_id = $1`, [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    walletAddress: row.vault_wallet_public_key,
    liquidityWalletAddress: row.liquidity_wallet_public_key,
    feeWalletAddress: row.fee_wallet_public_key,
    tokenMint: row.token_mint,
    cluster: row.cluster,
    state: row.state,
    launchState: row.launch_state,
    launchSignature: row.transaction_signature,
    supplyAtomic: row.supply_atomic,
    creatorAllocationAtomic: row.creator_allocation_atomic,
    creatorTokensReleasedAtomic: row.creator_tokens_released_atomic,
    creatorVestingWeeks: row.creator_vesting_weeks,
    vestingWeeksClaimed: Number(row.vesting_weeks_claimed),
    liquidityAllocationAtomic: row.liquidity_allocation_atomic,
    liquidityUnlockAt: row.liquidity_unlock_at,
    liquidityAllocationStatus: "held_in_separate_eoa_pending_dex_selection",
    buybackAmountAtomic: row.buyback_amount_atomic,
  };
}

chartersRouter.get("/me", requireAuth, async (request, response) => {
  const [charter, eligibility] = await Promise.all([
    launchState(request.auth!.userId),
    charterEligibility(request.auth!.walletAddress),
  ]);
  response.json({ data: { charter, eligibility } });
});

chartersRouter.post("/vesting/claim", requireAuth, async (request, response) => {
  z.object({}).parse(request.body ?? {});
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`charter:${request.auth!.userId}`]);
    const selected = await db.query<CharterRow>("SELECT * FROM charters WHERE user_id = $1 FOR UPDATE", [request.auth!.userId]);
    const charter = selected.rows[0];
    if (!charter || charter.state !== "active" || !charter.launched_at) throw new ApiError(409, "charter_not_active", "An active Charter token is required before creator vesting can be evaluated.");
    const elapsedWeeks = Math.min(charter.creator_vesting_weeks,
      Math.floor((Date.now() - charter.launched_at.getTime()) / (7 * 86_400_000)));
    let evaluated = 0;
    let scheduled = 0;
    for (let week = 1; week <= elapsedWeeks; week += 1) {
      const existing = await db.query<{ id: string; sla_met: boolean | null; eligible_amount_atomic: string; claimed_amount_atomic: string }>(
        "SELECT id, sla_met, eligible_amount_atomic::text, claimed_amount_atomic::text FROM charter_vesting_weeks WHERE user_id = $1 AND week_number = $2 FOR UPDATE",
        [request.auth!.userId, week],
      );
      let vestingWeek = existing.rows[0];
      if (!vestingWeek) {
        const start = new Date(charter.launched_at.getTime() + (week - 1) * 7 * 86_400_000);
        const end = new Date(charter.launched_at.getTime() + week * 7 * 86_400_000);
        const activity = await db.query<{ funded_jobs_due: number; jobs_completed_on_time: number }>(
          `SELECT count(DISTINCT c.id)::int AS funded_jobs_due,
                  count(DISTINCT c.id) FILTER (WHERE c.status = 'complete' AND wr.finalized_at <= c.deadline_at)::int AS jobs_completed_on_time
             FROM commissions c
             LEFT JOIN work_records wr ON wr.commission_id = c.id
            WHERE c.funded_at IS NOT NULL AND c.deadline_at > $2 AND c.deadline_at <= $3
              AND (c.provider_user_id = $1 OR EXISTS (
                SELECT 1 FROM work_record_payouts p WHERE p.work_record_id = wr.id AND p.user_id = $1 AND p.amount_atomic > 0
              ))`, [request.auth!.userId, start, end],
        );
        const due = activity.rows[0].funded_jobs_due;
        const onTime = activity.rows[0].jobs_completed_on_time;
        const slaMet = due === 0 || BigInt(onTime) * 10_000n >= BigInt(due) * BigInt(config.CHARTER_SLA_MINIMUM_ON_TIME_BPS);
        const totalAllocation = BigInt(charter.creator_allocation_atomic);
        const weeklyGrant = week === charter.creator_vesting_weeks
          ? totalAllocation - (totalAllocation / BigInt(charter.creator_vesting_weeks)) * BigInt(charter.creator_vesting_weeks - 1)
          : totalAllocation / BigInt(charter.creator_vesting_weeks);
        const saved = await db.query<{ id: string; sla_met: boolean; eligible_amount_atomic: string; claimed_amount_atomic: string }>(
          `INSERT INTO charter_vesting_weeks
             (user_id, week_number, period_start, period_end, sla_met, funded_jobs_due,
              jobs_completed_on_time, eligible_amount_atomic, evaluated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id, sla_met, eligible_amount_atomic::text, claimed_amount_atomic::text`,
          [request.auth!.userId, week, start, end, slaMet, due, onTime, (slaMet ? weeklyGrant : 0n).toString()],
        );
        vestingWeek = saved.rows[0];
        evaluated += 1;
      }
      if (vestingWeek.sla_met && BigInt(vestingWeek.eligible_amount_atomic) > BigInt(vestingWeek.claimed_amount_atomic)) {
        const amount = BigInt(vestingWeek.eligible_amount_atomic) - BigInt(vestingWeek.claimed_amount_atomic);
        const inserted = await db.query(
          `INSERT INTO charter_token_operations (user_id, kind, reference_id, output_mint, amount_atomic, destination_wallet)
           VALUES ($1, 'creator_vesting', $2, $3, $4, $5) ON CONFLICT (kind, reference_id) DO NOTHING RETURNING id`,
          [request.auth!.userId, vestingWeek.id, charter.token_mint, amount.toString(), request.auth!.walletAddress],
        );
        scheduled += inserted.rowCount ?? 0;
      }
    }
    await db.query("COMMIT");
    response.status(scheduled ? 202 : 200).json({ data: {
      weeksEvaluated: evaluated,
      operationsScheduled: scheduled,
      slaMinimumOnTimeBasisPoints: config.CHARTER_SLA_MINIMUM_ON_TIME_BPS,
      schedule: "Each elapsed seven-day period is evaluated once. A period with no funded work due is considered compliant; a failed period earns no tranche.",
    } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

chartersRouter.post("/launch-fee-instructions", requireAuth, async (request, response) => {
  if (config.CHARTER_LAUNCH_FEE_ATOMIC <= 0n) {
    response.json({ data: { state: "waived", amountAtomic: "0" } });
    return;
  }
  if (!config.USDC_MINT || !config.TREASURY_WALLET) {
    throw new ApiError(503, "charter_launch_fee_unavailable", "USDC and the treasury wallet are required to collect the Charter launch fee.");
  }
  const eligibility = await charterEligibility(request.auth!.walletAddress);
  if (!eligibility.eligible) throw new ApiError(409, "charter_not_eligible", "The signed-in wallet has not met every published Charter launch threshold.");
  let mint: PublicKey;
  let treasury: PublicKey;
  try { mint = new PublicKey(config.USDC_MINT); treasury = new PublicKey(config.TREASURY_WALLET); }
  catch { throw new ApiError(503, "charter_launch_fee_unavailable", "The configured USDC mint or treasury wallet is invalid."); }
  if (treasury.equals(new PublicKey(request.auth!.walletAddress))) {
    throw new ApiError(409, "charter_launch_fee_self_payment", "The treasury wallet cannot launch a Charter using its own address.");
  }

  const db = await pool.connect();
  let state = "awaiting_payment";
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`charter:${request.auth!.userId}`]);
    const existing = await db.query<{ amount_atomic: string; mint: string; treasury_wallet: string; state: string; payment_signature: string | null }>(
      "SELECT amount_atomic::text, mint, treasury_wallet, state, payment_signature FROM charter_launch_fee_payments WHERE user_id = $1 FOR UPDATE",
      [request.auth!.userId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.state === "paid") {
        await db.query("COMMIT");
        response.json({ data: { state: row.state, amountAtomic: row.amount_atomic, paymentSignature: row.payment_signature } });
        return;
      }
      await db.query(
        `UPDATE charter_launch_fee_payments SET amount_atomic = $2, mint = $3, treasury_wallet = $4, updated_at = now()
          WHERE user_id = $1`,
        [request.auth!.userId, config.CHARTER_LAUNCH_FEE_ATOMIC.toString(), mint.toBase58(), treasury.toBase58()],
      );
      state = row.state;
    } else {
      await db.query(
        `INSERT INTO charter_launch_fee_payments (user_id, amount_atomic, mint, treasury_wallet)
         VALUES ($1, $2, $3, $4)`,
        [request.auth!.userId, config.CHARTER_LAUNCH_FEE_ATOMIC.toString(), mint.toBase58(), treasury.toBase58()],
      );
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }

  const wallet = new PublicKey(request.auth!.walletAddress);
  const source = getAssociatedTokenAddressSync(mint, wallet);
  const destination = getAssociatedTokenAddressSync(mint, treasury);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: wallet, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, mint),
    createAssociatedTokenAccountIdempotentInstruction(wallet, destination, treasury, mint),
    createTransferCheckedInstruction(source, mint, destination, wallet, config.CHARTER_LAUNCH_FEE_ATOMIC, 6, [], TOKEN_PROGRAM_ID),
  );
  response.json({ data: {
    state, mint: mint.toBase58(), treasuryWallet: treasury.toBase58(), amountAtomic: config.CHARTER_LAUNCH_FEE_ATOMIC.toString(),
    unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  } });
});

chartersRouter.post("/launch-fee-confirm", requireAuth, async (request, response) => {
  const { signature } = z.object({ signature: z.string().min(80).max(100) }).parse(request.body);
  if (config.CHARTER_LAUNCH_FEE_ATOMIC <= 0n) {
    response.json({ data: { state: "waived", idempotentReplay: true } });
    return;
  }
  const record = await pool.query<{
    amount_atomic: string; mint: string; treasury_wallet: string; state: string; payment_signature: string | null;
  }>(
    "SELECT amount_atomic::text, mint, treasury_wallet, state, payment_signature FROM charter_launch_fee_payments WHERE user_id = $1",
    [request.auth!.userId],
  );
  const fee = record.rows[0];
  if (!fee) throw new ApiError(409, "charter_launch_fee_instructions_required", "Prepare the Charter launch fee payment before confirming it.");
  if (fee.state === "paid" && fee.payment_signature === signature) {
    response.json({ data: { state: "paid", amountAtomic: fee.amount_atomic, paymentSignature: signature, idempotentReplay: true } });
    return;
  }
  if (fee.state !== "awaiting_payment") throw new ApiError(409, "charter_launch_fee_already_paid", "The Charter launch fee is already paid with a different transaction.");
  if (BigInt(fee.amount_atomic) < config.CHARTER_LAUNCH_FEE_ATOMIC) {
    throw new ApiError(409, "charter_launch_fee_changed", "The configured Charter launch fee is higher than the prepared payment.");
  }
  let signatureBytes: Uint8Array;
  try { signatureBytes = bs58.decode(signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (signatureBytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "charter_launch_fee_unconfirmed", "The Charter launch fee payment is not confirmed on this cluster.");
  }
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "charter_launch_fee_transaction_unavailable", "The confirmed fee transaction details are not available yet.");
  const wallet = request.auth!.walletAddress;
  if (!parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer)) {
    throw new ApiError(422, "charter_launch_fee_signer_mismatch", "The signed-in wallet did not authorize this payment.");
  }
  const postBalances = parsed.meta.postTokenBalances ?? [];
  const destination = postBalances.find((balance) => balance.mint === fee.mint && balance.owner === fee.treasury_wallet);
  if (!destination || destination.uiTokenAmount.decimals !== 6) {
    throw new ApiError(422, "charter_launch_fee_destination_mismatch", "The payment did not reach the configured USDC treasury account.");
  }
  const before = (parsed.meta.preTokenBalances ?? []).find((balance) => balance.accountIndex === destination.accountIndex && balance.mint === fee.mint);
  const received = BigInt(destination.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
  const sourceDelta = tokenOwnerBalanceDelta(parsed.meta.preTokenBalances ?? [], postBalances, fee.mint, wallet);
  if (received !== BigInt(fee.amount_atomic) || sourceDelta !== -received) {
    throw new ApiError(422, "charter_launch_fee_amount_mismatch", "The signed-in wallet must transfer the exact configured USDC launch fee to the treasury.");
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`charter:${request.auth!.userId}`]);
    const current = await db.query<{ state: string; payment_signature: string | null; amount_atomic: string; mint: string; treasury_wallet: string }>(
      "SELECT state, payment_signature, amount_atomic::text, mint, treasury_wallet FROM charter_launch_fee_payments WHERE user_id = $1 FOR UPDATE", [request.auth!.userId],
    );
    if (current.rows[0]?.state === "paid" && current.rows[0].payment_signature === signature) {
      await db.query("COMMIT");
      response.json({ data: { state: "paid", amountAtomic: fee.amount_atomic, paymentSignature: signature, idempotentReplay: true } });
      return;
    }
    if (current.rows[0]?.state !== "awaiting_payment") throw new ApiError(409, "charter_launch_fee_already_paid", "The Charter launch fee is already paid with a different transaction.");
    if (current.rows[0].amount_atomic !== fee.amount_atomic || current.rows[0].mint !== fee.mint
      || current.rows[0].treasury_wallet !== fee.treasury_wallet) {
      throw new ApiError(409, "charter_launch_fee_instructions_changed", "The Charter launch fee terms changed while this payment was being confirmed. Prepare fresh instructions.");
    }
    const duplicate = await db.query("SELECT 1 FROM charter_launch_fee_payments WHERE payment_signature = $1 AND user_id <> $2", [signature, request.auth!.userId]);
    if (duplicate.rowCount) throw new ApiError(409, "charter_launch_fee_signature_used", "This transaction signature was already used for another Charter launch fee.");
    await db.query(
      `UPDATE charter_launch_fee_payments SET state = 'paid', payment_signature = $2,
         paid_at = now(), updated_at = now() WHERE user_id = $1`, [request.auth!.userId, signature],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  response.status(201).json({ data: { state: "paid", amountAtomic: fee.amount_atomic, paymentSignature: signature } });
});

chartersRouter.post("/launch", requireAuth, async (request, response) => {
  z.object({}).parse(request.body ?? {});
  const eligibility = await charterEligibility(request.auth!.walletAddress);
  if (!eligibility.eligible) throw new ApiError(409, "charter_not_eligible", "The signed-in wallet has not met every published Charter launch threshold.");

  const db = await pool.connect();
  let launch: { id: string; mint: string; signature: string; signedTransaction: Buffer; blockhash: string; lastValidBlockHeight: number } | null = null;
  let wasPrepared = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`charter:${request.auth!.userId}`]);
    let charter = (await db.query<CharterRow>("SELECT * FROM charters WHERE user_id = $1 FOR UPDATE", [request.auth!.userId])).rows[0];
    if (charter?.state === "active") {
      await db.query("COMMIT");
      response.json({ data: await launchState(request.auth!.userId), idempotentReplay: true });
      return;
    }
    if (config.CHARTER_LAUNCH_FEE_ATOMIC > 0n) {
      const fee = await db.query<{ amount_atomic: string; state: string }>(
        "SELECT amount_atomic::text, state FROM charter_launch_fee_payments WHERE user_id = $1 FOR UPDATE",
        [request.auth!.userId],
      );
      if (!fee.rows[0] || fee.rows[0].state !== "paid") {
        throw new ApiError(402, "charter_launch_fee_required", "Confirm the Charter launch fee payment before launching.");
      }
      if (BigInt(fee.rows[0].amount_atomic) < config.CHARTER_LAUNCH_FEE_ATOMIC) {
        throw new ApiError(409, "charter_launch_fee_changed", "The configured Charter launch fee is higher than the confirmed payment.");
      }
    }
    const operation = await db.query<{ id: string; state: string }>(
      "SELECT id, state FROM charter_launch_operations WHERE user_id = $1 FOR UPDATE", [request.auth!.userId],
    );
    if (operation.rows[0] && ["prepared", "submitted", "failed"].includes(operation.rows[0].state)) {
      const attempt = await db.query<{ token_mint: string; transaction_signature: string; signed_transaction: Buffer; recent_blockhash: string; last_valid_block_height: string }>(
        `SELECT token_mint, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height::text
           FROM charter_launch_attempts WHERE operation_id = $1 AND state IN ('prepared', 'submitted', 'expired') ORDER BY created_at DESC LIMIT 1`, [operation.rows[0].id],
      );
      if (attempt.rows[0]) {
        launch = { id: operation.rows[0].id, mint: attempt.rows[0].token_mint, signature: attempt.rows[0].transaction_signature,
          signedTransaction: attempt.rows[0].signed_transaction, blockhash: attempt.rows[0].recent_blockhash,
          lastValidBlockHeight: Number(attempt.rows[0].last_valid_block_height) };
        wasPrepared = true;
        await db.query("COMMIT");
      }
    }
    if (!launch) {
      const previousMint = charter?.token_mint;
      if (previousMint) {
        const chainAccount = await connection.getAccountInfo(new PublicKey(previousMint), config.SOLANA_COMMITMENT);
        if (chainAccount) throw new ApiError(409, "charter_launch_onchain_state", "The previous Charter launch created a mint on Solana and must be reconciled before retrying.");
      }
      if (!charter) {
        const vault = createEncryptedSolanaWallet();
        const liquidityVault = createEncryptedSolanaWallet();
        const feeWallet = createEncryptedSolanaWallet();
        const supply = supplyAtomic();
        const creator = supply * BigInt(config.CHARTER_CREATOR_SHARE_BPS) / 10_000n;
        const liquidity = supply - creator;
        await db.query(
          `INSERT INTO charters
             (user_id, token_mint, vault_wallet_public_key, encrypted_vault_secret_key,
              vault_encryption_nonce, vault_encryption_auth_tag, vault_encryption_key_version,
              liquidity_wallet_public_key, encrypted_liquidity_secret_key, liquidity_encryption_nonce,
              liquidity_encryption_auth_tag, liquidity_encryption_key_version,
              fee_wallet_public_key, encrypted_fee_secret_key, fee_encryption_nonce,
              fee_encryption_auth_tag, fee_encryption_key_version,
              cluster, supply_atomic, creator_allocation_atomic, liquidity_allocation_atomic,
              creator_vesting_weeks, liquidity_unlock_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NULL)`,
          [request.auth!.userId, Keypair.generate().publicKey.toBase58(), vault.publicKey, vault.encryptedSecretKey,
            vault.encryptionNonce, vault.encryptionAuthTag, vault.encryptionKeyVersion,
            liquidityVault.publicKey, liquidityVault.encryptedSecretKey, liquidityVault.encryptionNonce,
            liquidityVault.encryptionAuthTag, liquidityVault.encryptionKeyVersion,
            feeWallet.publicKey, feeWallet.encryptedSecretKey, feeWallet.encryptionNonce,
            feeWallet.encryptionAuthTag, feeWallet.encryptionKeyVersion, config.SOLANA_CLUSTER,
            supply.toString(), creator.toString(), liquidity.toString(), config.CHARTER_VESTING_WEEKS],
        );
        charter = (await db.query<CharterRow>("SELECT * FROM charters WHERE user_id = $1 FOR UPDATE", [request.auth!.userId])).rows[0];
      } else if (charter.cluster !== config.SOLANA_CLUSTER) {
        throw new ApiError(409, "charter_cluster_mismatch", "This Charter was prepared for a different Solana cluster.");
      } else {
        if (!charter.fee_wallet_public_key) {
          const feeWallet = createEncryptedSolanaWallet();
          await db.query(
            `UPDATE charters SET fee_wallet_public_key = $2, encrypted_fee_secret_key = $3,
               fee_encryption_nonce = $4, fee_encryption_auth_tag = $5,
               fee_encryption_key_version = $6, updated_at = now() WHERE user_id = $1`,
            [request.auth!.userId, feeWallet.publicKey, feeWallet.encryptedSecretKey,
              feeWallet.encryptionNonce, feeWallet.encryptionAuthTag, feeWallet.encryptionKeyVersion],
          );
          charter.fee_wallet_public_key = feeWallet.publicKey;
          charter.encrypted_fee_secret_key = feeWallet.encryptedSecretKey;
          charter.fee_encryption_nonce = feeWallet.encryptionNonce;
          charter.fee_encryption_auth_tag = feeWallet.encryptionAuthTag;
          charter.fee_encryption_key_version = feeWallet.encryptionKeyVersion;
        }
        const mint = Keypair.generate();
        await db.query("UPDATE charters SET token_mint = $2, state = 'prepared', updated_at = now() WHERE user_id = $1", [request.auth!.userId, mint.publicKey.toBase58()]);
        charter = (await db.query<CharterRow>("SELECT * FROM charters WHERE user_id = $1 FOR UPDATE", [request.auth!.userId])).rows[0];
      }
      const prepared = await prepareLaunchAttempt(charter!);
      await db.query(
        `INSERT INTO charter_launch_operations (user_id, state) VALUES ($1, 'prepared')
         ON CONFLICT (user_id) DO UPDATE SET state = 'prepared', updated_at = now() RETURNING id`, [request.auth!.userId],
      );
      const operationRow = await db.query<{ id: string }>("SELECT id FROM charter_launch_operations WHERE user_id = $1", [request.auth!.userId]);
      await db.query("UPDATE charters SET token_mint = $2, state = 'prepared', updated_at = now() WHERE user_id = $1", [request.auth!.userId, prepared.mint]);
      await db.query(
        `INSERT INTO charter_launch_attempts
           (operation_id, token_mint, signed_transaction, transaction_signature, recent_blockhash, last_valid_block_height, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'prepared')`,
        [operationRow.rows[0].id, prepared.mint, prepared.signedTransaction, prepared.signature, prepared.blockhash, prepared.lastValidBlockHeight],
      );
      launch = { id: operationRow.rows[0].id, ...prepared };
      await db.query("COMMIT");
    }
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }

  if (!launch) throw new Error("Charter launch preparation did not return an operation.");
  if (!wasPrepared || await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= launch.lastValidBlockHeight) {
    await connection.sendRawTransaction(launch.signedTransaction, { maxRetries: 3, skipPreflight: false });
    await pool.query("UPDATE charter_launch_attempts SET state = 'submitted', updated_at = now() WHERE transaction_signature = $1 AND state = 'prepared'", [launch.signature]);
    await pool.query("UPDATE charter_launch_operations SET state = 'submitted', updated_at = now() WHERE id = $1 AND state = 'prepared'", [launch.id]);
  }
  response.status(202).json({ data: {
    userId: request.auth!.userId,
    tokenMint: launch.mint,
    vaultWallet: (await pool.query<{ vault_wallet_public_key: string }>("SELECT vault_wallet_public_key FROM charters WHERE user_id = $1", [request.auth!.userId])).rows[0].vault_wallet_public_key,
    liquidityWallet: (await pool.query<{ liquidity_wallet_public_key: string }>("SELECT liquidity_wallet_public_key FROM charters WHERE user_id = $1", [request.auth!.userId])).rows[0].liquidity_wallet_public_key,
    feeWallet: (await pool.query<{ fee_wallet_public_key: string }>("SELECT fee_wallet_public_key FROM charters WHERE user_id = $1", [request.auth!.userId])).rows[0].fee_wallet_public_key,
    cluster: config.SOLANA_CLUSTER,
    state: "submitted",
    signature: launch.signature,
    supplyAtomic: supplyAtomic().toString(),
    decimals,
    idempotentReplay: wasPrepared,
  } });
});

export async function reconcileCharterLaunches(limit = 25) {
  const result = { examined: 0, confirmed: 0, submitted: 0, errors: [] as { operationId: string; code: string }[] };
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-charter-launch-reconcile')) AS acquired");
    if (!lock.rows[0]?.acquired) return result;
    locked = true;
    const due = await db.query<{ id: string; user_id: string; mint: string; supply_atomic: string; creator_allocation_atomic: string; liquidity_allocation_atomic: string; vault_wallet: string; liquidity_wallet: string; fee_wallet: string; signature: string; signed_transaction: Buffer; last_valid_block_height: string; attempt_id: string }>(
      `SELECT op.id, op.user_id, c.token_mint AS mint, c.supply_atomic::text,
              c.creator_allocation_atomic::text, c.liquidity_allocation_atomic::text,
              c.vault_wallet_public_key AS vault_wallet, c.liquidity_wallet_public_key AS liquidity_wallet,
              c.fee_wallet_public_key AS fee_wallet,
              a.transaction_signature AS signature, a.signed_transaction,
              a.last_valid_block_height::text, a.id AS attempt_id
         FROM charter_launch_operations op JOIN charters c ON c.user_id = op.user_id
         JOIN LATERAL (
           SELECT id, transaction_signature, signed_transaction, last_valid_block_height
             FROM charter_launch_attempts
            WHERE operation_id = op.id AND state IN ('prepared', 'submitted', 'expired')
            ORDER BY created_at DESC LIMIT 1
         ) a ON true
        WHERE op.state IN ('prepared', 'submitted', 'failed') ORDER BY op.created_at LIMIT $1`, [limit],
    );
    result.examined = due.rows.length;
    for (const row of due.rows) {
      try {
        const status = (await connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).value[0];
        const accountInfo = await connection.getAccountInfo(new PublicKey(row.mint), config.SOLANA_COMMITMENT);
        let confirmed = false;
        if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
          const mint = await getMint(connection, new PublicKey(row.mint), config.SOLANA_COMMITMENT, TOKEN_2022_PROGRAM_ID);
          const feeConfig = getTransferFeeConfig(mint);
          if (mint.supply !== BigInt(row.supply_atomic) || mint.mintAuthority !== null || mint.freezeAuthority !== null || mint.decimals !== decimals
            || !feeConfig || !feeConfig.transferFeeConfigAuthority.equals(PublicKey.default)
            || !feeConfig.withdrawWithheldAuthority?.equals(new PublicKey(row.fee_wallet))
            || feeConfig.olderTransferFee.transferFeeBasisPoints !== charterTransferFeeBps
            || feeConfig.newerTransferFee.transferFeeBasisPoints !== charterTransferFeeBps
            || feeConfig.olderTransferFee.maximumFee !== BigInt(row.supply_atomic)
            || feeConfig.newerTransferFee.maximumFee !== BigInt(row.supply_atomic)) {
            throw new Error("Charter mint does not match its fixed supply, immutable 1% transfer fee, fee authority, and revoked mint authorities.");
          }
          confirmed = await verifyCharterAllocation(row);
        } else if (accountInfo) {
          const mint = await getMint(connection, new PublicKey(row.mint), config.SOLANA_COMMITMENT, TOKEN_2022_PROGRAM_ID);
          const feeConfig = getTransferFeeConfig(mint);
          if (mint.supply === BigInt(row.supply_atomic) && mint.mintAuthority === null && mint.freezeAuthority === null
            && mint.decimals === decimals && feeConfig?.withdrawWithheldAuthority?.toBase58() === row.fee_wallet
            && feeConfig.transferFeeConfigAuthority.equals(PublicKey.default)
            && feeConfig.olderTransferFee.transferFeeBasisPoints === charterTransferFeeBps
            && feeConfig.newerTransferFee.transferFeeBasisPoints === charterTransferFeeBps
            && feeConfig.olderTransferFee.maximumFee === BigInt(row.supply_atomic)
            && feeConfig.newerTransferFee.maximumFee === BigInt(row.supply_atomic)) confirmed = await verifyCharterAllocation(row);
        }
        if (confirmed) {
          await db.query("BEGIN");
          await db.query("UPDATE charter_launch_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [row.attempt_id]);
          await db.query("UPDATE charter_launch_operations SET state = 'confirmed', updated_at = now() WHERE id = $1", [row.id]);
          await db.query("UPDATE charters SET state = 'active', launched_at = COALESCE(launched_at, now()), updated_at = now() WHERE user_id = $1", [row.user_id]);
          await db.query("COMMIT");
          result.confirmed += 1;
          continue;
        }
        if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
          await db.query("UPDATE charter_launch_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [row.attempt_id]);
          await db.query("UPDATE charter_launch_operations SET state = 'failed', updated_at = now() WHERE id = $1", [row.id]);
          await db.query("UPDATE charters SET state = 'failed', updated_at = now() WHERE user_id = $1", [row.user_id]);
          result.errors.push({ operationId: row.id, code: "charter_launch_transaction_failed" });
          continue;
        }
        if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(row.last_valid_block_height)) {
          throw new ApiError(409, "charter_launch_outcome_unknown", "The mint transaction expired without a verifiable Solana result. The backend will keep checking the original mint before allowing another launch.");
        }
        await connection.sendRawTransaction(row.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE charter_launch_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [row.attempt_id]);
        await db.query("UPDATE charter_launch_operations SET state = 'submitted', updated_at = now() WHERE id = $1", [row.id]);
        result.submitted += 1;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => undefined);
        result.errors.push({ operationId: row.id, code: error instanceof ApiError ? error.code : "charter_launch_reconcile_error" });
      }
    }
    return result;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-charter-launch-reconcile'))").catch(() => undefined);
    db.release();
  }
}

async function verifyCharterAllocation(row: {
  mint: string; vault_wallet: string; liquidity_wallet: string;
  creator_allocation_atomic: string; liquidity_allocation_atomic: string;
}) {
  const mint = new PublicKey(row.mint);
  const creatorAta = getAssociatedTokenAddressSync(mint, new PublicKey(row.vault_wallet), false, TOKEN_2022_PROGRAM_ID);
  const liquidityAta = getAssociatedTokenAddressSync(mint, new PublicKey(row.liquidity_wallet), false, TOKEN_2022_PROGRAM_ID);
  const [creatorInfo, liquidityInfo] = await Promise.all([
    connection.getAccountInfo(creatorAta, config.SOLANA_COMMITMENT),
    connection.getAccountInfo(liquidityAta, config.SOLANA_COMMITMENT),
  ]);
  if (!creatorInfo || !liquidityInfo) return false;
  const [creator, liquidity] = await Promise.all([
    getAccount(connection, creatorAta, config.SOLANA_COMMITMENT, TOKEN_2022_PROGRAM_ID),
    getAccount(connection, liquidityAta, config.SOLANA_COMMITMENT, TOKEN_2022_PROGRAM_ID),
  ]);
  const withheld = getTransferFeeAmount(liquidity)?.withheldAmount ?? 0n;
  const expectedFee = (BigInt(row.liquidity_allocation_atomic) * BigInt(charterTransferFeeBps) + 9_999n) / 10_000n;
  return creator.amount === BigInt(row.creator_allocation_atomic)
    && liquidity.amount + withheld === BigInt(row.liquidity_allocation_atomic)
    && withheld === expectedFee;
}

export async function reconcileCharterTokenOperations(limit = 25) {
  const result = { examined: 0, confirmed: 0, submitted: 0, errors: [] as { operationId: string; code: string }[] };
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-charter-token-reconcile')) AS acquired");
    if (!lock.rows[0]?.acquired) return result;
    locked = true;
    const due = await db.query<{
      id: string; user_id: string; reference_id: string; amount_atomic: string; destination_wallet: string;
      output_mint: string; state: string; token_mint: string; vault_wallet_public_key: string;
      encrypted_vault_secret_key: Buffer; vault_encryption_nonce: Buffer; vault_encryption_auth_tag: Buffer;
      vault_encryption_key_version: number;
    }>(
      `SELECT op.id, op.user_id, op.reference_id, op.amount_atomic::text, op.destination_wallet,
              op.output_mint, op.state, c.token_mint, c.vault_wallet_public_key,
              c.encrypted_vault_secret_key, c.vault_encryption_nonce, c.vault_encryption_auth_tag,
              c.vault_encryption_key_version
         FROM charter_token_operations op JOIN charters c ON c.user_id = op.user_id
        WHERE op.kind = 'creator_vesting' AND op.state IN ('queued', 'submitted', 'failed')
        ORDER BY op.created_at LIMIT $1`, [limit],
    );
    result.examined = due.rows.length;
    for (const operation of due.rows) {
      try {
        const attempts = await db.query<{ id: string; signature: string; signed_transaction: Buffer; last_valid_block_height: string; state: string }>(
          `SELECT id, transaction_signature AS signature, signed_transaction, last_valid_block_height::text, state
             FROM charter_token_operation_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
        );
        let attempt: { id: string; signature: string; signed_transaction: Buffer; last_valid_block_height: string; state: string } | undefined = attempts.rows[0];
        if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
          const status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
          if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await db.query("UPDATE charter_token_operation_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
            await db.query("UPDATE charter_token_operations SET state = 'failed', updated_at = now() WHERE id = $1", [operation.id]);
            result.errors.push({ operationId: operation.id, code: "charter_vesting_transaction_failed" });
            continue;
          }
          if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await confirmCharterTokenOperation(db, operation, attempt.id, attempt.signature);
            result.confirmed += 1;
            continue;
          }
          if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
            await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
            await db.query("UPDATE charter_token_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
            await db.query("UPDATE charter_token_operations SET state = 'submitted', updated_at = now() WHERE id = $1", [operation.id]);
            result.submitted += 1;
            continue;
          }
          throw new ApiError(409, "charter_vesting_outcome_unknown", "The creator vesting transfer expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
        }
        if (!attempt || ["failed"].includes(attempt.state)) {
          const vault = new PublicKey(operation.vault_wallet_public_key);
          const mint = new PublicKey(operation.output_mint);
          const source = getAssociatedTokenAddressSync(mint, vault, false, TOKEN_2022_PROGRAM_ID);
          const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
          if (!sourceInfo) throw new ApiError(409, "charter_vault_balance_low", "The Charter token vault has no token account for vesting.");
          const balance = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
          if (balance < BigInt(operation.amount_atomic)) throw new ApiError(409, "charter_vault_balance_low", "The Charter token vault has insufficient tokens for the creator vesting tranche.");
          const vaultKey = Keypair.fromSecretKey(decryptSolanaSecretKey({
            ciphertext: operation.encrypted_vault_secret_key,
            nonce: operation.vault_encryption_nonce,
            authTag: operation.vault_encryption_auth_tag,
            keyVersion: operation.vault_encryption_key_version,
          }));
          if (!vaultKey.publicKey.equals(vault)) throw new Error("Charter vault key does not match its recorded address.");
          const recipient = new PublicKey(operation.destination_wallet);
          const destination = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
          const payer = loadSolanaFeePayer();
          const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
          const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, recipient, mint, TOKEN_2022_PROGRAM_ID),
            createTransferCheckedInstruction(source, mint, destination, vault, BigInt(operation.amount_atomic), decimals, [], TOKEN_2022_PROGRAM_ID),
          );
          transaction.partialSign(payer, vaultKey);
          if (!transaction.signature) throw new Error("Signed Charter vesting transaction has no signature.");
          const signature = bs58.encode(transaction.signature);
          const signedTransaction = transaction.serialize();
          const saved = await db.query<{ id: string }>(
            `INSERT INTO charter_token_operation_attempts
               (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
             VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
            [operation.id, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
          );
          attempt = { id: saved.rows[0].id, signature, signed_transaction: signedTransaction,
            last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
        }
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE charter_token_operation_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE charter_token_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.signature]);
        result.submitted += 1;
      } catch (error) {
        result.errors.push({ operationId: operation.id, code: error instanceof ApiError ? error.code : "charter_token_operation_error" });
      }
    }
    return result;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-charter-token-reconcile'))").catch(() => undefined);
    db.release();
  }
}

async function charterFeeSources(mint: PublicKey, cursor: string | null, collector: PublicKey) {
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: config.SOLANA_COMMITMENT,
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const available = accounts.flatMap(({ pubkey, account }) => {
    if (pubkey.equals(collector)) return [];
    try {
      const parsed = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      return (getTransferFeeAmount(parsed)?.withheldAmount ?? 0n) > 0n ? [pubkey] : [];
    } catch { return []; }
  }).sort((left, right) => left.toBase58().localeCompare(right.toBase58()));
  if (!cursor || !available.length) return available.slice(0, 12);
  const afterCursor = available.filter((address) => address.toBase58() > cursor);
  return [...afterCursor, ...available.filter((address) => address.toBase58() <= cursor)].slice(0, 12);
}

/** Collect Charter Token-2022 transfer fees and pay 70% to the agent treasury and 30% to GuildHall. */
export async function reconcileCharterTransferFees(limit = 25) {
  const result = { examined: 0, collected: 0, distributed: 0, submitted: 0,
    errors: [] as { operationId: string; code: string }[] };
  if (!config.TREASURY_WALLET) return result;
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-charter-transfer-fee-reconcile')) AS acquired");
    if (!lock.rows[0]?.acquired) return result;
    locked = true;
    const charters = await db.query<{
      user_id: string; token_mint: string; fee_wallet_public_key: string;
      encrypted_fee_secret_key: Buffer; fee_encryption_nonce: Buffer;
      fee_encryption_auth_tag: Buffer; fee_encryption_key_version: number;
      wallet_address: string; fee_account_cursor: string | null;
    }>(
      `SELECT c.user_id, c.token_mint, c.fee_wallet_public_key, c.encrypted_fee_secret_key,
              c.fee_encryption_nonce, c.fee_encryption_auth_tag, c.fee_encryption_key_version,
              c.fee_account_cursor, u.wallet_address
         FROM charters c JOIN wallet_users u ON u.id = c.user_id
        WHERE c.state = 'active' AND c.fee_wallet_public_key IS NOT NULL
        ORDER BY COALESCE(c.fee_reconciled_at, '-infinity'::timestamptz), c.user_id LIMIT $1`, [limit],
    );
    for (const charter of charters.rows) {
      let operationId = "";
      try {
        let operation = (await db.query<{ id: string; state: string }>(
          `SELECT id, state FROM charter_transfer_fee_operations
            WHERE user_id = $1 AND state <> 'complete' ORDER BY created_at LIMIT 1`, [charter.user_id],
        )).rows[0];
        const mint = new PublicKey(charter.token_mint);
        const feeWallet = Keypair.fromSecretKey(decryptSolanaSecretKey({
          ciphertext: charter.encrypted_fee_secret_key, nonce: charter.fee_encryption_nonce,
          authTag: charter.fee_encryption_auth_tag, keyVersion: charter.fee_encryption_key_version,
        }));
        if (feeWallet.publicKey.toBase58() !== charter.fee_wallet_public_key) throw new Error("Charter fee key does not match its recorded address.");
        const collector = getAssociatedTokenAddressSync(mint, feeWallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        if (!operation) {
          const sources = await charterFeeSources(mint, charter.fee_account_cursor, collector);
          const collectorInfo = await connection.getAccountInfo(collector, config.SOLANA_COMMITMENT);
          const collectorBalance = collectorInfo
            ? BigInt((await connection.getTokenAccountBalance(collector, config.SOLANA_COMMITMENT)).value.amount) : 0n;
          if (!sources.length && collectorBalance < minimumCharterFeeDistributionAtomic) continue;
          operation = (await db.query<{ id: string; state: string }>(
            `INSERT INTO charter_transfer_fee_operations (user_id, state, collected_amount_atomic)
             VALUES ($1, $2, $3) RETURNING id, state`,
            [charter.user_id, collectorBalance >= minimumCharterFeeDistributionAtomic ? "distributing" : "collecting", collectorBalance.toString()],
          )).rows[0];
        }
        operationId = operation.id;
        result.examined += 1;
        const latest = await db.query<{
          id: string; stage: string; signature: string; signed_transaction: Buffer;
          last_valid_block_height: string; state: string;
        }>(
          `SELECT id, stage, transaction_signature AS signature, signed_transaction,
                  last_valid_block_height::text, state
             FROM charter_transfer_fee_attempts WHERE operation_id = $1
            ORDER BY created_at DESC LIMIT 1`, [operation.id],
        );
        let attempt: (typeof latest.rows)[number] | undefined = latest.rows[0];
        if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
          const status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
          if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "") && !status.err) {
            await db.query("UPDATE charter_transfer_fee_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
            if (attempt.stage === "collect") {
              const amount = BigInt((await connection.getTokenAccountBalance(collector, config.SOLANA_COMMITMENT)).value.amount);
              await db.query("UPDATE charter_transfer_fee_operations SET state = 'distributing', collected_amount_atomic = $2, updated_at = now() WHERE id = $1", [operation.id, amount.toString()]);
              result.collected += 1;
            } else {
              await db.query("UPDATE charter_transfer_fee_operations SET state = 'complete', updated_at = now() WHERE id = $1", [operation.id]);
              result.distributed += 1;
            }
            continue;
          }
          if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await db.query("UPDATE charter_transfer_fee_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
            attempt = undefined;
          } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(attempt.last_valid_block_height)) {
            throw new ApiError(409, "charter_fee_transfer_outcome_unknown", "The Token-2022 fee transaction expired without a verifiable Solana result. The original transaction will be checked again before another collection or distribution is prepared.");
          } else {
            await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
            await db.query("UPDATE charter_transfer_fee_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
            result.submitted += 1;
            continue;
          }
        }
        if (attempt && ["failed"].includes(attempt.state)) attempt = undefined;
        if (!attempt) {
          const payer = loadSolanaFeePayer();
          const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
          const transaction = new Transaction({ feePayer: payer.publicKey, ...latestBlockhash });
          let stage: "collect" | "distribute";
          const collectorInfo = await connection.getAccountInfo(collector, config.SOLANA_COMMITMENT);
          const collectorBalance = collectorInfo
            ? BigInt((await connection.getTokenAccountBalance(collector, config.SOLANA_COMMITMENT)).value.amount) : 0n;
          if (collectorBalance < minimumCharterFeeDistributionAtomic) {
            const sources = await charterFeeSources(mint, charter.fee_account_cursor, collector);
            if (!sources.length) continue;
            await db.query("UPDATE charter_transfer_fee_operations SET state = 'collecting', updated_at = now() WHERE id = $1", [operation.id]);
            transaction.add(
              createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, collector, feeWallet.publicKey, mint, TOKEN_2022_PROGRAM_ID),
              createWithdrawWithheldTokensFromAccountsInstruction(mint, collector, feeWallet.publicKey, [], sources, TOKEN_2022_PROGRAM_ID),
            );
            await db.query("UPDATE charters SET fee_account_cursor = $2 WHERE user_id = $1", [charter.user_id, sources[sources.length - 1].toBase58()]);
            charter.fee_account_cursor = sources[sources.length - 1].toBase58();
            stage = "collect";
          } else {
            const treasury = new PublicKey(config.TREASURY_WALLET);
            const creator = new PublicKey(charter.wallet_address);
            const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
            const treasuryAta = getAssociatedTokenAddressSync(mint, treasury, false, TOKEN_2022_PROGRAM_ID);
            const creatorAmount = creator.equals(treasury) ? collectorBalance : collectorBalance * 70n / 100n;
            const treasuryAmount = creator.equals(treasury) ? 0n : collectorBalance - creatorAmount;
            transaction.add(
              createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, creatorAta, creator, mint, TOKEN_2022_PROGRAM_ID),
              createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasuryAta, treasury, mint, TOKEN_2022_PROGRAM_ID),
            );
            if (creator.equals(treasury)) {
              transaction.add(createTransferCheckedInstruction(collector, mint, creatorAta, feeWallet.publicKey, collectorBalance, decimals, [], TOKEN_2022_PROGRAM_ID));
            } else {
              if (creatorAmount > 0n) transaction.add(createTransferCheckedInstruction(collector, mint, creatorAta, feeWallet.publicKey, creatorAmount, decimals, [], TOKEN_2022_PROGRAM_ID));
              if (treasuryAmount > 0n) transaction.add(createTransferCheckedInstruction(collector, mint, treasuryAta, feeWallet.publicKey, treasuryAmount, decimals, [], TOKEN_2022_PROGRAM_ID));
            }
            stage = "distribute";
          }
          transaction.partialSign(payer, feeWallet);
          if (!transaction.signature) throw new Error("Charter transfer-fee transaction has no signature.");
          const signature = bs58.encode(transaction.signature);
          const signed = transaction.serialize();
          const saved = await db.query<{ id: string }>(
            `INSERT INTO charter_transfer_fee_attempts
               (operation_id, stage, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'prepared') RETURNING id`,
            [operation.id, stage, signature, signed, latestBlockhash.blockhash, latestBlockhash.lastValidBlockHeight],
          );
          await connection.sendRawTransaction(signed, { maxRetries: 3, skipPreflight: false });
          await db.query("UPDATE charter_transfer_fee_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [saved.rows[0].id]);
          result.submitted += 1;
        }
      } catch (error) {
        result.errors.push({ operationId: operationId || charter.user_id, code: error instanceof ApiError ? error.code : "charter_transfer_fee_reconcile_error" });
      } finally {
        await db.query("UPDATE charters SET fee_reconciled_at = now() WHERE user_id = $1", [charter.user_id]).catch(() => undefined);
      }
    }
    return result;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-charter-transfer-fee-reconcile'))").catch(() => undefined);
    db.release();
  }
}

type CharterBuybackRow = {
  id: string; user_id: string; asset_mint: string; amount_atomic: string;
  token_mint: string; vault_wallet_public_key: string; encrypted_vault_secret_key: Buffer;
  vault_encryption_nonce: Buffer; vault_encryption_auth_tag: Buffer;
  vault_encryption_key_version: number; state: "queued" | "swapped" | "burned" | "failed";
};

type CharterBuybackAttempt = {
  id: string; kind: "swap" | "burn"; transaction_signature: string;
  signed_transaction: Buffer; last_valid_block_height: string;
  jupiter_request_id: string | null; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
};

async function markCharterBuybackSwapConfirmed(
  db: import("pg").PoolClient, row: CharterBuybackRow, attempt: CharterBuybackAttempt, outputAmount: string,
) {
  if (!/^\d+$/.test(outputAmount) || BigInt(outputAmount) <= 0n) throw new Error("Confirmed Charter buyback returned no tokens.");
  await db.query("BEGIN");
  try {
    await db.query("UPDATE charter_buyback_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query(
      `UPDATE charter_buybacks SET state = 'swapped', swap_signature = $2,
         token_amount_atomic = $3, updated_at = now() WHERE id = $1 AND state IN ('queued', 'failed')`,
      [row.id, attempt.transaction_signature, outputAmount],
    );
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}

async function charterBuybackOutputAmount(signature: string, tokenMint: string, vaultWallet: string) {
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) return null;
  const ata = getAssociatedTokenAddressSync(new PublicKey(tokenMint), new PublicKey(vaultWallet), false, TOKEN_2022_PROGRAM_ID).toBase58();
  const accountIndex = parsed.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === ata);
  if (accountIndex < 0) return null;
  const before = parsed.meta.preTokenBalances?.filter((balance) => balance.accountIndex === accountIndex && balance.mint === tokenMint)
    .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
  const after = parsed.meta.postTokenBalances?.filter((balance) => balance.accountIndex === accountIndex && balance.mint === tokenMint)
    .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
  const received = after - before;
  return received > 0n ? received.toString() : null;
}

async function submitCharterBuybackSwap(row: CharterBuybackRow, attempt: CharterBuybackAttempt) {
  if (!config.JUPITER_API_KEY || !attempt.jupiter_request_id) throw new Error("Jupiter is not configured for Charter buybacks.");
  const response = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.JUPITER_API_KEY },
    body: JSON.stringify({ signedTransaction: attempt.signed_transaction.toString("base64"),
      requestId: attempt.jupiter_request_id, lastValidBlockHeight: Number(attempt.last_valid_block_height) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Jupiter did not accept the prepared Charter buyback swap.");
  const result = await response.json() as { status?: string; code?: number; signature?: string; totalOutputAmount?: string };
  if (result.status === "Success" && result.code === 0 && result.totalOutputAmount) {
    if (result.signature && result.signature !== attempt.transaction_signature) throw new Error("Jupiter returned a different Charter buyback transaction signature.");
    const db = await pool.connect();
    try { await markCharterBuybackSwapConfirmed(db, row, attempt, result.totalOutputAmount); }
    finally { db.release(); }
    return "confirmed" as const;
  }
  if (result.status === "Failed") {
    const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
    if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      if (!status.err) {
        const output = await charterBuybackOutputAmount(attempt.transaction_signature, row.token_mint, row.vault_wallet_public_key);
        if (!output) throw new Error("Confirmed Charter buyback did not expose its Token-2022 output balance.");
        const db = await pool.connect();
        try { await markCharterBuybackSwapConfirmed(db, row, attempt, output); }
        finally { db.release(); }
        return "confirmed" as const;
      }
      await pool.query("UPDATE charter_buyback_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
      await pool.query("UPDATE charter_buybacks SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'queued'", [row.id]);
      return "failed" as const;
    }
    if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(attempt.last_valid_block_height)) {
      await pool.query("UPDATE charter_buyback_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
      throw new ApiError(409, "charter_buyback_outcome_unknown", "The Jupiter buyback expired without a verifiable Solana result. The original swap will be checked again before another swap is prepared.");
    }
  }
  await pool.query("UPDATE charter_buyback_attempts SET state = 'submitted', updated_at = now() WHERE id = $1 AND state = 'prepared'", [attempt.id]);
  return "submitted" as const;
}

export async function reconcileCharterBuybacks(limit = 25) {
  const result = { examined: 0, swapped: 0, burned: 0, submitted: 0,
    waitingForJupiter: 0, errors: [] as { buybackId: string; code: string }[] };
  if (!config.JUPITER_API_KEY) { result.waitingForJupiter = 1; return result; }
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-charter-buyback-reconcile')) AS acquired");
    if (!lock.rows[0]?.acquired) return result;
    locked = true;
    const due = await db.query<CharterBuybackRow>(
      `SELECT b.id, b.user_id, b.asset_mint, b.amount_atomic::text, b.state,
              c.token_mint, c.vault_wallet_public_key, c.encrypted_vault_secret_key,
              c.vault_encryption_nonce, c.vault_encryption_auth_tag, c.vault_encryption_key_version
         FROM charter_buybacks b JOIN charters c ON c.user_id = b.user_id
        WHERE b.state IN ('queued', 'swapped', 'failed') AND c.state = 'active'
        ORDER BY b.created_at LIMIT $1`, [limit],
    );
    result.examined = due.rows.length;
    for (const row of due.rows) {
      try {
        const latest = await db.query<CharterBuybackAttempt>(
          `SELECT id, kind, transaction_signature, signed_transaction, last_valid_block_height::text,
                  jupiter_request_id, state FROM charter_buyback_attempts
            WHERE buyback_id = $1 ORDER BY created_at DESC LIMIT 1`, [row.id],
        );
        let attempt: CharterBuybackAttempt | undefined = latest.rows[0];
        if (attempt && ["failed"].includes(attempt.state)) attempt = undefined;
        if (attempt && ["prepared", "submitted", "expired", "outcome_unknown"].includes(attempt.state)) {
          const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
          if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            if (status.err) {
              await db.query("UPDATE charter_buyback_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
              if (attempt.kind === "swap") await db.query("UPDATE charter_buybacks SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'queued'", [row.id]);
              continue;
            }
            if (attempt.kind === "swap") {
              const output = await charterBuybackOutputAmount(attempt.transaction_signature, row.token_mint, row.vault_wallet_public_key);
              if (!output) throw new Error("Confirmed buyback transaction did not expose its Token-2022 output balance.");
              await markCharterBuybackSwapConfirmed(db, row, attempt, output);
              result.swapped += 1;
            } else {
              await db.query("BEGIN");
              try {
                await db.query("UPDATE charter_buyback_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
                await db.query("UPDATE charter_buybacks SET state = 'burned', burn_signature = $2, updated_at = now() WHERE id = $1 AND state = 'swapped'", [row.id, attempt.transaction_signature]);
                await db.query("COMMIT");
              } catch (error) { await db.query("ROLLBACK"); throw error; }
              result.burned += 1;
            }
            attempt = undefined;
            continue;
          }
          if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await db.query("UPDATE charter_buyback_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
            if (attempt.kind === "swap") await db.query("UPDATE charter_buybacks SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'queued'", [row.id]);
            attempt = undefined;
          } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(attempt.last_valid_block_height)) {
            await db.query("UPDATE charter_buyback_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [attempt.id]);
            throw new ApiError(409, "charter_buyback_outcome_unknown", "The Charter buyback expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
          } else if (attempt.kind === "burn") {
            await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
            await db.query("UPDATE charter_buyback_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
            result.submitted += 1;
            continue;
          } else {
            const state = await submitCharterBuybackSwap(row, attempt);
            if (state === "confirmed") result.swapped += 1;
            else if (state === "submitted") result.submitted += 1;
            continue;
          }
        }

        if (!attempt && row.state === "swapped") {
          const mint = new PublicKey(row.token_mint);
          const vault = new PublicKey(row.vault_wallet_public_key);
          const source = getAssociatedTokenAddressSync(mint, vault, false, TOKEN_2022_PROGRAM_ID);
          const info = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
          if (!info) throw new Error("Charter buyback vault token account is missing after a confirmed swap.");
          const available = BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount);
          const amount = await db.query<{ token_amount_atomic: string }>("SELECT token_amount_atomic::text FROM charter_buybacks WHERE id = $1", [row.id]);
          const burnAmount = BigInt(amount.rows[0]?.token_amount_atomic ?? "0");
          if (burnAmount <= 0n || available < burnAmount) throw new Error("Charter buyback vault has insufficient tokens to burn the confirmed output.");
          const vaultKey = Keypair.fromSecretKey(decryptSolanaSecretKey({
            ciphertext: row.encrypted_vault_secret_key, nonce: row.vault_encryption_nonce,
            authTag: row.vault_encryption_auth_tag, keyVersion: row.vault_encryption_key_version,
          }));
          if (!vaultKey.publicKey.equals(vault)) throw new Error("Charter vault key does not match its recorded public key.");
          const payer = loadSolanaFeePayer();
          const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
          const transaction = new Transaction({ feePayer: payer.publicKey, ...latestBlockhash }).add(
            createBurnCheckedInstruction(source, mint, vault, burnAmount, decimals, [], TOKEN_2022_PROGRAM_ID),
          );
          transaction.partialSign(payer, vaultKey);
          if (!transaction.signature) throw new Error("Charter buyback burn has no transaction signature.");
          const signed = transaction.serialize();
          const signature = bs58.encode(transaction.signature);
          const saved = await db.query<{ id: string }>(
            `INSERT INTO charter_buyback_attempts
               (buyback_id, kind, transaction_signature, signed_transaction, recent_blockhash,
                last_valid_block_height, state)
             VALUES ($1, 'burn', $2, $3, $4, $5, 'prepared') RETURNING id`,
            [row.id, signature, signed, latestBlockhash.blockhash, latestBlockhash.lastValidBlockHeight],
          );
          attempt = { id: saved.rows[0].id, kind: "burn", transaction_signature: signature,
            signed_transaction: signed, last_valid_block_height: String(latestBlockhash.lastValidBlockHeight),
            jupiter_request_id: null, state: "prepared" };
        } else if (!attempt && ["queued", "failed"].includes(row.state)) {
          const vault = new PublicKey(row.vault_wallet_public_key);
          const inputMint = new PublicKey(row.asset_mint);
          const outputMint = new PublicKey(row.token_mint);
          const payer = loadSolanaFeePayer();
          const vaultKey = Keypair.fromSecretKey(decryptSolanaSecretKey({
            ciphertext: row.encrypted_vault_secret_key, nonce: row.vault_encryption_nonce,
            authTag: row.vault_encryption_auth_tag, keyVersion: row.vault_encryption_key_version,
          }));
          if (!vaultKey.publicKey.equals(vault)) throw new Error("Charter vault key does not match its recorded public key.");
          const orderUrl = new URL("https://api.jup.ag/swap/v2/order");
          orderUrl.search = new URLSearchParams({ inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
            amount: row.amount_atomic, taker: vault.toBase58(), payer: payer.publicKey.toBase58(),
            maxSupportedTransactionVersion: "0" }).toString();
          const orderResponse = await fetch(orderUrl, { headers: { "x-api-key": config.JUPITER_API_KEY! }, signal: AbortSignal.timeout(10_000) });
          if (!orderResponse.ok) throw new Error("Jupiter could not quote this Charter buyback.");
          const order = await orderResponse.json() as JupiterSwapOrder;
          const validatedOrder = validateJupiterSwapOrder(order, {
            inputMint, outputMint, inputAmountAtomic: row.amount_atomic, taker: vaultKey, payer,
          });
          const transaction = validatedOrder.transaction;
          transaction.sign([payer, vaultKey]);
          const signed = Buffer.from(transaction.serialize());
          const signature = bs58.encode(transaction.signatures[0]);
          const saved = await db.query<{ id: string }>(
            `INSERT INTO charter_buyback_attempts
               (buyback_id, kind, transaction_signature, signed_transaction, recent_blockhash,
                last_valid_block_height, jupiter_request_id, expected_output_atomic, router, state)
             VALUES ($1, 'swap', $2, $3, $4, $5, $6, $7, $8, 'prepared') RETURNING id`,
            [row.id, signature, signed, transaction.message.recentBlockhash, validatedOrder.lastValidBlockHeight,
              validatedOrder.requestId, validatedOrder.outputAmount, validatedOrder.router],
          );
          attempt = { id: saved.rows[0].id, kind: "swap", transaction_signature: signature,
            signed_transaction: signed, last_valid_block_height: validatedOrder.lastValidBlockHeight,
            jupiter_request_id: validatedOrder.requestId, state: "prepared" };
        }
        if (!attempt) continue;
        if (attempt.kind === "swap") {
          const state = await submitCharterBuybackSwap(row, attempt);
          if (state === "confirmed") result.swapped += 1;
          else if (state === "submitted") result.submitted += 1;
        } else {
          await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
          await db.query("UPDATE charter_buyback_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
          result.submitted += 1;
        }
      } catch (error) {
        result.errors.push({ buybackId: row.id, code: error instanceof ApiError ? error.code : "charter_buyback_reconcile_error" });
      }
    }
    return result;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-charter-buyback-reconcile'))").catch(() => undefined);
    db.release();
  }
}

async function confirmCharterTokenOperation(
  db: import("pg").PoolClient,
  operation: { id: string; user_id: string; reference_id: string; amount_atomic: string },
  attemptId: string,
  signature: string,
) {
  await db.query("BEGIN");
  try {
    const saved = await db.query("UPDATE charter_token_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1 AND state <> 'confirmed' RETURNING id", [operation.id, signature]);
    await db.query("UPDATE charter_token_operation_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attemptId]);
    if (saved.rowCount) {
      await db.query("UPDATE charter_vesting_weeks SET claimed_amount_atomic = eligible_amount_atomic, updated_at = now() WHERE id = $1 AND user_id = $2", [operation.reference_id, operation.user_id]);
      await db.query("UPDATE charters SET creator_tokens_released_atomic = creator_tokens_released_atomic + $2::numeric, updated_at = now() WHERE user_id = $1", [operation.user_id, operation.amount_atomic]);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
