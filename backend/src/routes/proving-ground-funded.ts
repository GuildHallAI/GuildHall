import { Router } from "express";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type { PoolClient } from "pg";
import bs58 from "bs58";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { decryptSolanaSecretKey } from "../escrow-wallets.js";
import { loadSolanaFeePayer } from "../solana-fee-payer.js";
import { validateJupiterSwapOrder, type JupiterSwapOrder } from "../jupiter-order.js";

export const provingGroundFundedRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const wrappedSolMint = "So11111111111111111111111111111111111111112";

const tradeSchema = z.object({
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/),
});

type FundedAccount = {
  id: string;
  user_id: string;
  state: string;
  asset_mint: string;
  funded_wallet_public_key: string;
  encrypted_funded_wallet_secret_key: Buffer;
  funded_wallet_encryption_nonce: Buffer;
  funded_wallet_encryption_auth_tag: Buffer;
  funded_wallet_encryption_key_version: number;
};

type FundedTrade = {
  id: string;
  account_id: string;
  user_id: string;
  idempotency_key: string;
  side: "buy" | "sell";
  input_mint: string;
  output_mint: string;
  input_amount_atomic: string;
  expected_output_atomic: string;
  actual_output_atomic: string | null;
  jupiter_request_id: string;
  transaction_signature: string;
  signed_transaction: Buffer;
  recent_blockhash: string;
  last_valid_block_height: string;
  router: string;
  state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
  failure_code: string | null;
};

type JupiterExecution = {
  status?: "Success" | "Failed";
  signature?: string;
  code?: number;
  totalOutputAmount?: string;
  error?: string;
};

function configuredUsdcMint() {
  if (!config.USDC_MINT) throw new ApiError(503, "proving_ground_unavailable", "USDC_MINT is required for funded trading.");
  try { return new PublicKey(config.USDC_MINT).toBase58(); }
  catch { throw new ApiError(503, "proving_ground_misconfigured", "USDC_MINT is not a valid Solana address."); }
}

function parseAtomic(amount: string, decimals: number) {
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new ApiError(400, "invalid_trade_amount", `This trade amount supports at most ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

function treasuryAddress() {
  if (!config.TREASURY_WALLET) throw new ApiError(503, "proving_ground_unavailable", "TREASURY_WALLET is required for profit settlement.");
  try { return new PublicKey(config.TREASURY_WALLET); }
  catch { throw new ApiError(503, "proving_ground_misconfigured", "TREASURY_WALLET is not a valid Solana address."); }
}

function accountKey(account: FundedAccount) {
  const secret = decryptSolanaSecretKey({
    ciphertext: account.encrypted_funded_wallet_secret_key,
    nonce: account.funded_wallet_encryption_nonce,
    authTag: account.funded_wallet_encryption_auth_tag,
    keyVersion: account.funded_wallet_encryption_key_version,
  });
  const keypair = Keypair.fromSecretKey(secret);
  if (keypair.publicKey.toBase58() !== account.funded_wallet_public_key) {
    throw new Error("Proving Ground funded account key does not match its recorded address.");
  }
  return keypair;
}

async function submitToJupiter(trade: FundedTrade) {
  if (!config.JUPITER_API_KEY) throw new ApiError(503, "funded_trading_unavailable", "Configure JUPITER_API_KEY before enabling funded account trades.");
  const response = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.JUPITER_API_KEY },
    body: JSON.stringify({
      signedTransaction: trade.signed_transaction.toString("base64"),
      requestId: trade.jupiter_request_id,
      lastValidBlockHeight: Number(trade.last_valid_block_height),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Jupiter swap execution did not accept the prepared transaction.");
  const result = await response.json() as JupiterExecution;
  if (result.status === "Success" && result.code === 0) {
    if (result.signature && result.signature !== trade.transaction_signature) {
      throw new Error("Jupiter confirmed a different transaction signature than the prepared trade.");
    }
    await pool.query(
      `UPDATE proving_ground_funded_trades SET state = 'confirmed',
         actual_output_atomic = $2, updated_at = now() WHERE id = $1 AND state IN ('prepared', 'submitted')`,
      [trade.id, result.totalOutputAmount && /^\d+$/.test(result.totalOutputAmount) ? result.totalOutputAmount : null],
    );
    return { state: "confirmed" as const, signature: trade.transaction_signature,
      actualOutputAtomic: result.totalOutputAmount ?? null };
  }
  if (result.status === "Failed") {
    const status = (await connection.getSignatureStatuses([trade.transaction_signature], { searchTransactionHistory: true })).value[0];
    if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
      if (!status.err) {
        await pool.query(
          `UPDATE proving_ground_funded_trades SET state = 'confirmed', actual_output_atomic = $2, updated_at = now()
            WHERE id = $1 AND state IN ('prepared', 'submitted')`,
          [trade.id, result.totalOutputAmount && /^\d+$/.test(result.totalOutputAmount) ? result.totalOutputAmount : null],
        );
        return { state: "confirmed" as const, signature: trade.transaction_signature,
          actualOutputAtomic: result.totalOutputAmount ?? null };
      }
      await pool.query(
        `UPDATE proving_ground_funded_trades SET state = 'failed', failure_code = 'chain_transaction_failed', updated_at = now()
          WHERE id = $1 AND state IN ('prepared', 'submitted')`, [trade.id],
      );
      return { state: "failed" as const, signature: trade.transaction_signature, failureCode: "chain_transaction_failed" };
    }
    if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(trade.last_valid_block_height)) {
      await pool.query(
        `UPDATE proving_ground_funded_trades SET state = 'outcome_unknown', failure_code = 'chain_outcome_unknown', updated_at = now()
          WHERE id = $1 AND state IN ('prepared', 'submitted')`, [trade.id],
      );
      throw new ApiError(409, "funded_trade_outcome_unknown", "The Jupiter swap expired without a verifiable Solana result. The original signature will be checked again before another swap is prepared.");
    }
  }
  await pool.query("UPDATE proving_ground_funded_trades SET state = 'submitted', updated_at = now() WHERE id = $1 AND state = 'prepared'", [trade.id]);
  return { state: "submitted" as const, signature: trade.transaction_signature };
}

async function findFundedTrade(db: PoolClient, accountId: string, userId: string, idempotencyKey: string) {
  const result = await db.query<FundedTrade>(
    `SELECT id, account_id, user_id, idempotency_key, side, input_mint, output_mint,
            input_amount_atomic::text, expected_output_atomic::text, actual_output_atomic::text,
            jupiter_request_id, transaction_signature, signed_transaction, recent_blockhash,
            last_valid_block_height::text, router, state, failure_code
       FROM proving_ground_funded_trades
      WHERE account_id = $1 AND user_id = $2 AND idempotency_key = $3 FOR UPDATE`,
    [accountId, userId, idempotencyKey],
  );
  return result.rows[0];
}

provingGroundFundedRouter.post("/accounts/:accountId/funded-trades", requireAuth, async (request, response) => {
  const accountId = z.string().uuid().parse(request.params.accountId);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ApiError(400, "idempotency_key_required", "A valid Idempotency-Key header is required.");
  }
  const input = tradeSchema.parse(request.body);
  if (!config.JUPITER_API_KEY) throw new ApiError(503, "funded_trading_unavailable", "Configure JUPITER_API_KEY before enabling funded account trades.");
  const usdcMint = configuredUsdcMint();
  const solMint = new PublicKey(wrappedSolMint).toBase58();
  const inputMint = input.side === "buy" ? usdcMint : solMint;
  const outputMint = input.side === "buy" ? solMint : usdcMint;
  const inputDecimals = input.side === "buy" ? 6 : 9;
  const inputAmount = parseAtomic(input.amount, inputDecimals);
  if (inputAmount <= 0n) throw new ApiError(400, "invalid_trade_amount", "Trade amount must be greater than zero.");

  const db = await pool.connect();
  let saved: FundedTrade;
  let replay = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground-funded:${accountId}`]);
    const existing = await findFundedTrade(db, accountId, request.auth!.userId, idempotencyKey);
    if (existing) {
      saved = existing;
      replay = true;
      await db.query("COMMIT");
    } else {
      const pending = await db.query(
        `SELECT 1 FROM proving_ground_funded_trades
          WHERE account_id = $1 AND state IN ('prepared', 'submitted', 'outcome_unknown') LIMIT 1`, [accountId],
      );
      if (pending.rowCount) throw new ApiError(409, "funded_trade_in_progress", "A funded account trade is still confirming.");
      const selected = await db.query<FundedAccount>(
        `SELECT id, user_id, state, asset_mint, funded_wallet_public_key,
                encrypted_funded_wallet_secret_key, funded_wallet_encryption_nonce,
                funded_wallet_encryption_auth_tag, funded_wallet_encryption_key_version
           FROM proving_ground_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [accountId, request.auth!.userId],
      );
      const account = selected.rows[0];
      if (!account) throw new ApiError(404, "proving_ground_account_not_found", "Proving Ground account not found.");
      if (account.state !== "funded") throw new ApiError(409, "funded_account_inactive", "This account has not completed challenge funding.");
      if (account.asset_mint !== usdcMint) throw new ApiError(409, "funded_account_asset_mismatch", "The funded account uses a different USDC mint.");

      const payer = loadSolanaFeePayer();
      const fundedKey = accountKey(account);
      const orderUrl = new URL("https://api.jup.ag/swap/v2/order");
      orderUrl.search = new URLSearchParams({
        inputMint, outputMint, amount: inputAmount.toString(),
        taker: fundedKey.publicKey.toBase58(), payer: payer.publicKey.toBase58(),
        maxSupportedTransactionVersion: "0",
      }).toString();
      const orderResponse = await fetch(orderUrl, {
        headers: { "x-api-key": config.JUPITER_API_KEY }, signal: AbortSignal.timeout(10_000),
      });
      if (!orderResponse.ok) throw new ApiError(502, "swap_quote_unavailable", "Jupiter could not prepare a funded account trade.");
      const order = await orderResponse.json() as JupiterSwapOrder;
      let validatedOrder: ReturnType<typeof validateJupiterSwapOrder>;
      try {
        validatedOrder = validateJupiterSwapOrder(order, {
          inputMint: new PublicKey(inputMint), outputMint: new PublicKey(outputMint),
          inputAmountAtomic: inputAmount.toString(), taker: fundedKey, payer,
        });
      } catch {
        throw new ApiError(502, "swap_quote_invalid", "Jupiter returned an order outside the requested funded trade policy.");
      }
      const { transaction } = validatedOrder;
      const message = transaction.message;
      transaction.sign([payer, fundedKey]);
      const signed = Buffer.from(transaction.serialize());
      const signature = bs58.encode(transaction.signatures[0]);
      const blockhash = message.recentBlockhash;
      const inserted = await db.query<FundedTrade>(
        `INSERT INTO proving_ground_funded_trades
           (account_id, user_id, idempotency_key, side, input_mint, output_mint,
            input_amount_atomic, expected_output_atomic, jupiter_request_id,
            transaction_signature, signed_transaction, recent_blockhash,
            last_valid_block_height, router)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, account_id, user_id, idempotency_key, side, input_mint, output_mint,
                   input_amount_atomic::text, expected_output_atomic::text, actual_output_atomic::text,
                   jupiter_request_id, transaction_signature, signed_transaction, recent_blockhash,
                   last_valid_block_height::text, router, state, failure_code`,
        [accountId, request.auth!.userId, idempotencyKey, input.side, inputMint, outputMint,
          inputAmount.toString(), validatedOrder.outputAmount, order.requestId, signature, signed, blockhash,
          validatedOrder.lastValidBlockHeight, order.router],
      );
      saved = inserted.rows[0];
      await db.query("COMMIT");
    }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { db.release(); }

  if (saved.state === "confirmed" || saved.state === "failed" || saved.state === "expired" || saved.state === "outcome_unknown") {
    response.json({ data: {
      tradeId: saved.id, state: saved.state, side: saved.side,
      inputMint: saved.input_mint, outputMint: saved.output_mint,
      inputAmountAtomic: saved.input_amount_atomic,
      expectedOutputAtomic: saved.expected_output_atomic,
      actualOutputAtomic: saved.actual_output_atomic,
      signature: saved.transaction_signature, failureCode: saved.failure_code,
    }, idempotentReplay: replay });
    return;
  }
  try {
    const execution = await submitToJupiter(saved);
    response.status(execution.state === "confirmed" ? 200 : execution.state === "failed" ? 409 : 202).json({
      data: { tradeId: saved.id, side: saved.side, router: saved.router,
        inputMint: saved.input_mint, outputMint: saved.output_mint,
        inputAmountAtomic: saved.input_amount_atomic,
        expectedOutputAtomic: saved.expected_output_atomic,
        actualOutputAtomic: "actualOutputAtomic" in execution ? execution.actualOutputAtomic : null,
        signature: execution.signature, state: execution.state,
        failureCode: "failureCode" in execution ? execution.failureCode : null },
      idempotentReplay: replay,
    });
  } catch {
    const current = await pool.query<{ state: FundedTrade["state"] }>(
      "SELECT state FROM proving_ground_funded_trades WHERE id = $1", [saved.id],
    );
    const state = current.rows[0]?.state ?? saved.state;
    response.status(202).json({ data: { tradeId: saved.id, state, signature: saved.transaction_signature }, idempotentReplay: replay });
  }
});

provingGroundFundedRouter.post("/accounts/:accountId/profit-settlements", requireAuth, async (request, response) => {
  const accountId = z.string().uuid().parse(request.params.accountId);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ApiError(400, "idempotency_key_required", "A valid Idempotency-Key header is required.");
  }
  z.object({}).parse(request.body ?? {});
  const treasury = treasuryAddress();
  const mint = new PublicKey(configuredUsdcMint());
  const clientWallet = new PublicKey(request.auth!.walletAddress);
  const db = await pool.connect();
  let settlement: {
    id: string; transaction_signature: string; signed_transaction: Buffer;
    last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "outcome_unknown";
    profit_atomic: string; trader_amount_atomic: string; pool_amount_atomic: string; protocol_amount_atomic: string;
  };
  let replay = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground-funded:${accountId}`]);
    const previous = await db.query<typeof settlement>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state,
              profit_atomic::text, trader_amount_atomic::text, pool_amount_atomic::text, protocol_amount_atomic::text
         FROM proving_ground_profit_settlements
        WHERE account_id = $1 AND user_id = $2 AND idempotency_key = $3 FOR UPDATE`,
      [accountId, request.auth!.userId, idempotencyKey],
    );
    if (previous.rows[0]) {
      settlement = previous.rows[0];
      replay = true;
      await db.query("COMMIT");
    } else {
      const pending = await db.query(
        `SELECT 1 FROM proving_ground_profit_settlements
          WHERE account_id = $1 AND state IN ('prepared', 'submitted', 'outcome_unknown') LIMIT 1`, [accountId],
      );
      if (pending.rowCount) throw new ApiError(409, "profit_settlement_in_progress", "A profit settlement is still confirming.");
      const selected = await db.query<FundedAccount & { funded_high_water_mark_atomic: string | null }>(
        `SELECT id, user_id, state, asset_mint, funded_wallet_public_key,
                encrypted_funded_wallet_secret_key, funded_wallet_encryption_nonce,
                funded_wallet_encryption_auth_tag, funded_wallet_encryption_key_version,
                funded_high_water_mark_atomic::text
           FROM proving_ground_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [accountId, request.auth!.userId],
      );
      const account = selected.rows[0];
      if (!account) throw new ApiError(404, "proving_ground_account_not_found", "Proving Ground account not found.");
      if (account.state !== "funded" || !account.funded_high_water_mark_atomic) {
        throw new ApiError(409, "funded_account_inactive", "Only an active funded account can settle profits.");
      }
      if (account.asset_mint !== mint.toBase58()) throw new ApiError(409, "funded_account_asset_mismatch", "The funded account uses a different USDC mint.");
      const hasPendingTrades = await db.query(
        `SELECT 1 FROM proving_ground_funded_trades
          WHERE account_id = $1 AND state IN ('prepared', 'submitted', 'outcome_unknown') LIMIT 1`, [accountId],
      );
      if (hasPendingTrades.rowCount) throw new ApiError(409, "funded_trade_in_progress", "Wait for the active funded trade to confirm before settling profits.");

      const fundedWallet = new PublicKey(account.funded_wallet_public_key);
      const sourceAta = getAssociatedTokenAddressSync(mint, fundedWallet);
      const balanceInfo = await connection.getAccountInfo(sourceAta, config.SOLANA_COMMITMENT);
      const cash = balanceInfo
        ? BigInt((await connection.getTokenAccountBalance(sourceAta, config.SOLANA_COMMITMENT)).value.amount)
        : 0n;
      const wrappedAta = getAssociatedTokenAddressSync(new PublicKey(wrappedSolMint), fundedWallet);
      const wrappedInfo = await connection.getAccountInfo(wrappedAta, config.SOLANA_COMMITMENT);
      const wrappedBalance = wrappedInfo
        ? BigInt((await connection.getTokenAccountBalance(wrappedAta, config.SOLANA_COMMITMENT)).value.amount)
        : 0n;
      if (wrappedBalance !== 0n) throw new ApiError(409, "open_sol_position", "Sell the funded account's SOL position before settling profits.");
      const highWaterMark = BigInt(account.funded_high_water_mark_atomic);
      if (cash <= highWaterMark) throw new ApiError(409, "no_profit_to_settle", "The account has no USDC profit above its high-water mark.");
      const profit = cash - highWaterMark;
      const traderAmount = profit * 8_000n / 10_000n;
      const poolAmount = profit * 1_500n / 10_000n;
      const protocolAmount = profit - traderAmount - poolAmount;
      const poolRow = await db.query<{ wallet_public_key: string; asset_mint: string; cluster: string }>(
        "SELECT wallet_public_key, asset_mint, cluster FROM proving_ground_pool WHERE id = 1",
      );
      if (!poolRow.rows[0] || poolRow.rows[0].asset_mint !== mint.toBase58() || poolRow.rows[0].cluster !== config.SOLANA_CLUSTER) {
        throw new ApiError(503, "proving_ground_pool_unavailable", "The configured funded account pool is not ready for profit settlement.");
      }
      const poolWallet = new PublicKey(poolRow.rows[0].wallet_public_key);
      const feePayer = loadSolanaFeePayer();
      const sourceKey = accountKey(account);
      const destinations = [
        { wallet: clientWallet, amount: traderAmount },
        { wallet: poolWallet, amount: poolAmount },
        { wallet: treasury, amount: protocolAmount },
      ];
      const transaction = new Transaction({ feePayer: feePayer.publicKey });
      for (const destination of destinations) {
        if (destination.amount === 0n) continue;
        const ata = getAssociatedTokenAddressSync(mint, destination.wallet);
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ata, destination.wallet, mint),
          createTransferCheckedInstruction(sourceAta, mint, ata, sourceKey.publicKey,
            destination.amount, 6, [], TOKEN_PROGRAM_ID),
        );
      }
      const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      transaction.recentBlockhash = latest.blockhash;
      transaction.partialSign(feePayer, sourceKey);
      if (!transaction.signature) throw new Error("Profit settlement transaction has no signature.");
      const signedTransaction = transaction.serialize();
      const inserted = await db.query<typeof settlement>(
        `INSERT INTO proving_ground_profit_settlements
           (account_id, user_id, idempotency_key, high_water_mark_atomic, profit_atomic,
            trader_amount_atomic, pool_amount_atomic, protocol_amount_atomic,
            transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, transaction_signature, signed_transaction, last_valid_block_height::text,
                   state, profit_atomic::text, trader_amount_atomic::text, pool_amount_atomic::text, protocol_amount_atomic::text`,
        [accountId, request.auth!.userId, idempotencyKey, highWaterMark.toString(), profit.toString(),
          traderAmount.toString(), poolAmount.toString(), protocolAmount.toString(),
          bs58.encode(transaction.signature), signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
      );
      settlement = inserted.rows[0];
      await db.query("COMMIT");
    }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { db.release(); }

  if (["confirmed", "failed", "expired", "outcome_unknown"].includes(settlement.state)) {
    response.json({ data: { ...settlement }, idempotentReplay: replay });
    return;
  }
  try {
    await connection.sendRawTransaction(settlement.signed_transaction, { maxRetries: 3, skipPreflight: false });
    await pool.query("UPDATE proving_ground_profit_settlements SET state = 'submitted', updated_at = now() WHERE id = $1 AND state = 'prepared'", [settlement.id]);
    response.status(202).json({ data: { id: settlement.id, state: "submitted",
      profitAtomic: settlement.profit_atomic, traderAmountAtomic: settlement.trader_amount_atomic,
      poolAmountAtomic: settlement.pool_amount_atomic, protocolAmountAtomic: settlement.protocol_amount_atomic,
      signature: settlement.transaction_signature }, idempotentReplay: replay });
  } catch {
    response.status(202).json({ data: { id: settlement.id, state: "prepared",
      profitAtomic: settlement.profit_atomic, signature: settlement.transaction_signature }, idempotentReplay: replay });
  }
});

export async function reconcileProvingGroundFundedTrades(limit = 25) {
  const result = { examined: 0, confirmed: 0, failed: 0, retried: 0, errors: [] as { tradeId: string; code: string }[] };
  const due = await pool.query<FundedTrade>(
    `SELECT id, account_id, user_id, idempotency_key, side, input_mint, output_mint,
            input_amount_atomic::text, expected_output_atomic::text, actual_output_atomic::text,
            jupiter_request_id, transaction_signature, signed_transaction, recent_blockhash,
            last_valid_block_height::text, router, state, failure_code
       FROM proving_ground_funded_trades WHERE state IN ('prepared', 'submitted', 'outcome_unknown')
      ORDER BY created_at LIMIT $1`, [limit],
  );
  result.examined = due.rows.length;
  for (const trade of due.rows) {
    try {
      const signatureStatus = (await connection.getSignatureStatuses([trade.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (signatureStatus && ["confirmed", "finalized"].includes(signatureStatus.confirmationStatus ?? "")) {
        if (signatureStatus.err) {
          await pool.query("UPDATE proving_ground_funded_trades SET state = 'failed', failure_code = 'chain_transaction_failed', updated_at = now() WHERE id = $1", [trade.id]);
          result.failed += 1;
        } else {
          await pool.query("UPDATE proving_ground_funded_trades SET state = 'confirmed', updated_at = now() WHERE id = $1", [trade.id]);
          result.confirmed += 1;
        }
        continue;
      }
      if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(trade.last_valid_block_height)) {
        await pool.query(
          `UPDATE proving_ground_funded_trades SET state = 'outcome_unknown', failure_code = 'chain_outcome_unknown', updated_at = now()
            WHERE id = $1 AND state IN ('prepared', 'submitted')`, [trade.id],
        );
        result.errors.push({ tradeId: trade.id, code: "funded_trade_outcome_unknown" });
        continue;
      }
      await submitToJupiter(trade);
      result.retried += 1;
    } catch (error) {
      result.errors.push({ tradeId: trade.id,
        code: error instanceof ApiError ? error.code : "funded_trade_reconcile_error" });
    }
  }
  const settlements = { examined: 0, confirmed: 0, failed: 0, retried: 0,
    errors: [] as { settlementId: string; code: string }[] };
  const pendingSettlements = await pool.query<{
    id: string; transaction_signature: string; signed_transaction: Buffer; last_valid_block_height: string;
  }>(
    `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text
       FROM proving_ground_profit_settlements WHERE state IN ('prepared', 'submitted', 'outcome_unknown')
      ORDER BY created_at LIMIT $1`, [limit],
  );
  settlements.examined = pendingSettlements.rows.length;
  for (const settlement of pendingSettlements.rows) {
    try {
      const status = (await connection.getSignatureStatuses([settlement.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        if (status.err) {
          await pool.query("UPDATE proving_ground_profit_settlements SET state = 'failed', failure_code = 'chain_transaction_failed', updated_at = now() WHERE id = $1", [settlement.id]);
          settlements.failed += 1;
        } else {
          await pool.query("UPDATE proving_ground_profit_settlements SET state = 'confirmed', updated_at = now() WHERE id = $1", [settlement.id]);
          settlements.confirmed += 1;
        }
        continue;
      }
      if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) > Number(settlement.last_valid_block_height)) {
        await pool.query(
          `UPDATE proving_ground_profit_settlements SET state = 'outcome_unknown', failure_code = 'chain_outcome_unknown', updated_at = now()
            WHERE id = $1 AND state IN ('prepared', 'submitted')`, [settlement.id],
        );
        settlements.errors.push({ settlementId: settlement.id, code: "profit_settlement_outcome_unknown" });
        continue;
      }
      await connection.sendRawTransaction(settlement.signed_transaction, { maxRetries: 3, skipPreflight: false });
      await pool.query("UPDATE proving_ground_profit_settlements SET state = 'submitted', updated_at = now() WHERE id = $1", [settlement.id]);
      settlements.retried += 1;
    } catch {
      settlements.errors.push({ settlementId: settlement.id, code: "profit_settlement_reconcile_error" });
    }
  }
  Object.assign(result, { profitSettlements: settlements });
  return result;
}
