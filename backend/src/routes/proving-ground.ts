import { Router } from "express";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { z } from "zod";
import type { PoolClient } from "pg";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { latestPythPrice } from "../pyth-oracle.js";
import { createEncryptedSolanaWallet, decryptSolanaSecretKey } from "../escrow-wallets.js";
import { loadSolanaFeePayer } from "../solana-fee-payer.js";

export const provingGroundRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const uuid = z.string().uuid();
const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/);
const market = "SOL/USD";
const marketDecimals = 9;
const scale = 1_000_000_000n;

function usdcMint() {
  if (!config.USDC_MINT) throw new ApiError(503, "proving_ground_unavailable", "USDC_MINT is required for Proving Ground fees.");
  try { return new PublicKey(config.USDC_MINT).toBase58(); }
  catch { throw new ApiError(503, "proving_ground_misconfigured", "USDC_MINT is not a valid Solana address."); }
}

function treasuryWallet() {
  if (!config.TREASURY_WALLET) throw new ApiError(503, "proving_ground_unavailable", "TREASURY_WALLET is required for Proving Ground challenge fees.");
  try { return new PublicKey(config.TREASURY_WALLET).toBase58(); }
  catch { throw new ApiError(503, "proving_ground_misconfigured", "TREASURY_WALLET is not a valid Solana address."); }
}

function toTokenAtomic(value: string) {
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fractional.padEnd(marketDecimals, "0"));
}

function notionalAtomic(quantity: bigint, priceAtomic: bigint) {
  return quantity * priceAtomic / scale;
}

function drawdownBps(reference: bigint, value: bigint) {
  if (reference <= 0n || value >= reference) return 0;
  return Number((reference - value) * 10_000n / reference);
}

function utcDayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function verifyFeeTransaction(input: { signature: string; encoded: string; wallet: string }) {
  let bytes: Uint8Array;
  try { bytes = bs58.decode(input.signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (bytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "challenge_fee_unconfirmed", "The challenge fee transaction must confirm on Solana first.");
  }
  const actual = await connection.getTransaction(input.signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!actual || actual.meta?.err) throw new ApiError(409, "challenge_fee_unavailable", "Confirmed transaction details are not available yet.");
  const expected = Transaction.from(Buffer.from(input.encoded, "base64"));
  const exactMessage = Buffer.from(actual.transaction.message.serialize()).equals(expected.compileMessage().serialize());
  const exactSignature = actual.transaction.signatures.includes(input.signature);
  const signer = new PublicKey(input.wallet);
  const signedByWallet = actual.transaction.message.staticAccountKeys
    .slice(0, actual.transaction.message.header.numRequiredSignatures).some((key) => key.equals(signer));
  if (!exactMessage || !exactSignature || !signedByWallet) {
    throw new ApiError(422, "challenge_fee_mismatch", "The confirmed transaction does not match the prepared challenge fee payment.");
  }
}

type Account = {
  id: string; user_id: string; state: string; asset_mint: string; fee_atomic: string;
  fee_signature: string | null; fee_unsigned_transaction: string | null;
  fee_recent_blockhash: string | null; fee_last_valid_block_height: string | null;
  funded_wallet_public_key: string | null; funded_at: Date | null;
  funded_high_water_mark_atomic?: string | null;
  initial_equity_atomic: string; cash_balance_atomic: string; peak_equity_atomic: string;
  day_open_equity_atomic: string; day_open_at: Date; started_at: Date | null; ends_at: Date | null;
  failure_reason: string | null;
};

type ProvingGroundPool = {
  wallet_public_key: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
  encryption_auth_tag: Buffer; encryption_key_version: number; cluster: string; asset_mint: string;
};

type FundingAttempt = {
  id: string; transaction_signature: string; signed_transaction: Buffer;
  last_valid_block_height: string; state: "prepared" | "submitted" | "confirmed" | "failed" | "expired";
};

async function ensureProvingGroundPool(db: PoolClient): Promise<ProvingGroundPool> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('guildhall-proving-ground-pool'))");
  const existing = await db.query<ProvingGroundPool>("SELECT * FROM proving_ground_pool WHERE id = 1 FOR UPDATE");
  const mint = usdcMint();
  if (existing.rows[0]) {
    if (existing.rows[0].asset_mint !== mint || existing.rows[0].cluster !== config.SOLANA_CLUSTER) {
      throw new ApiError(409, "proving_ground_pool_mismatch", "The Proving Ground pool was created for another cluster or USDC mint.");
    }
    return existing.rows[0];
  }
  const wallet = createEncryptedSolanaWallet();
  const result = await db.query<ProvingGroundPool>(
    `INSERT INTO proving_ground_pool
       (id, wallet_public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag,
        encryption_key_version, cluster, asset_mint)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce, wallet.encryptionAuthTag,
      wallet.encryptionKeyVersion, config.SOLANA_CLUSTER, mint],
  );
  return result.rows[0];
}

async function provingPoolBalance(poolRow: ProvingGroundPool) {
  const mint = new PublicKey(poolRow.asset_mint);
  const tokenAccount = getAssociatedTokenAddressSync(mint, new PublicKey(poolRow.wallet_public_key));
  const info = await connection.getAccountInfo(tokenAccount, config.SOLANA_COMMITMENT);
  if (!info) return 0n;
  const result = await connection.getTokenAccountBalance(tokenAccount, config.SOLANA_COMMITMENT);
  if (result.value.decimals !== 6) throw new ApiError(422, "proving_ground_asset_decimals", "The Proving Ground funding mint must use six decimals.");
  return BigInt(result.value.amount);
}

async function provingPoolReservedBalance() {
  const reserved = await pool.query<{ amount_atomic: string }>(
    `SELECT COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
       FROM proving_ground_funding_operations
      WHERE kind = 'allocation' AND state IN ('queued', 'submitted', 'failed')`,
  );
  return BigInt(reserved.rows[0]?.amount_atomic ?? "0");
}

async function markFundingConfirmed(operationId: string, attempt: FundingAttempt) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = await db.query<{ account_id: string; state: string }>(
      "SELECT account_id, state FROM proving_ground_funding_operations WHERE id = $1 FOR UPDATE", [operationId],
    );
    if (!row.rows[0]) throw new Error("Proving Ground funding operation is missing.");
    await db.query("UPDATE proving_ground_funding_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [attempt.id]);
    await db.query(
      "UPDATE proving_ground_funding_operations SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1",
      [operationId, attempt.transaction_signature],
    );
    const updated = await db.query(
      `UPDATE proving_ground_accounts SET state = 'funded', funded_at = COALESCE(funded_at, now()),
         funded_high_water_mark_atomic = COALESCE(funded_high_water_mark_atomic, initial_equity_atomic), updated_at = now()
        WHERE id = $1 AND state = 'funding_pending' RETURNING id`, [row.rows[0].account_id],
    );
    if (!updated.rowCount && row.rows[0].state !== "confirmed") throw new Error("Proving Ground account is not awaiting its funding transfer.");
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

provingGroundRouter.get("/markets", (_request, response) => {
  response.json({ data: {
    markets: config.PROVING_GROUND_SOL_USD_FEED_ID ? [{ symbol: market, priceSource: "Pyth", baseDecimals: marketDecimals }] : [],
    challenge: {
      initialCapitalAtomic: config.PROVING_GROUND_INITIAL_CAPITAL_ATOMIC.toString(),
      feeAtomic: config.PROVING_GROUND_CHALLENGE_FEE_ATOMIC.toString(),
      durationDays: config.PROVING_GROUND_DURATION_DAYS,
      targetBasisPoints: config.PROVING_GROUND_TARGET_BPS,
      dailyDrawdownBasisPoints: config.PROVING_GROUND_DAILY_DRAWDOWN_BPS,
      totalDrawdownBasisPoints: config.PROVING_GROUND_TOTAL_DRAWDOWN_BPS,
    },
    configured: Boolean(config.USDC_MINT && config.TREASURY_WALLET && config.PYTH_API_KEY && config.PROVING_GROUND_SOL_USD_FEED_ID),
    fundedTradingConfigured: Boolean(config.USDC_MINT && config.JUPITER_API_KEY),
  } });
});

provingGroundRouter.get("/pool", async (_request, response) => {
  const db = await pool.connect();
  let poolRow: ProvingGroundPool;
  try {
    await db.query("BEGIN");
    poolRow = await ensureProvingGroundPool(db);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  const onchainBalance = await provingPoolBalance(poolRow);
  const reservedBalance = await provingPoolReservedBalance();
  response.json({ data: {
    walletAddress: poolRow.wallet_public_key,
    assetMint: poolRow.asset_mint,
    cluster: poolRow.cluster,
    balanceAtomic: onchainBalance.toString(),
    reservedBalanceAtomic: reservedBalance.toString(),
    availableBalanceAtomic: (onchainBalance > reservedBalance ? onchainBalance - reservedBalance : 0n).toString(),
  } });
});

provingGroundRouter.get("/me", requireAuth, async (request, response) => {
  const account = await pool.query<Account>(
    `SELECT * FROM proving_ground_accounts WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 1`, [request.auth!.userId],
  );
  if (!account.rows[0]) { response.json({ data: { account: null } }); return; }
  const row = account.rows[0];
  const [position, trades, fundedTrades, profitSettlements] = await Promise.all([
    pool.query<{ quantity_atomic: string; average_entry_price_atomic: string }>(
      "SELECT quantity_atomic::text, average_entry_price_atomic::text FROM proving_ground_positions WHERE account_id = $1 AND market = $2",
      [row.id, market],
    ),
    pool.query(
      `SELECT id, market, side, quantity_atomic::text, price_atomic::text, notional_atomic::text,
              oracle_publish_time, created_at FROM proving_ground_trades
        WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`, [row.id],
    ),
    pool.query(
      `SELECT id, side, input_mint, output_mint, input_amount_atomic::text,
              expected_output_atomic::text, actual_output_atomic::text, transaction_signature,
              router, state, failure_code, created_at FROM proving_ground_funded_trades
        WHERE account_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`, [row.id, request.auth!.userId],
    ),
    pool.query(
      `SELECT id, profit_atomic::text, trader_amount_atomic::text, pool_amount_atomic::text,
              protocol_amount_atomic::text, transaction_signature, state, failure_code, created_at
         FROM proving_ground_profit_settlements WHERE account_id = $1 AND user_id = $2
        ORDER BY created_at DESC LIMIT 50`, [row.id, request.auth!.userId],
    ),
  ]);
  let mark: { priceAtomic: string; publishTime: Date; equityAtomic: string } | null = null;
  if (row.state === "active" && config.PROVING_GROUND_SOL_USD_FEED_ID) {
    const price = await latestPythPrice(config.PROVING_GROUND_SOL_USD_FEED_ID);
    const quantity = BigInt(position.rows[0]?.quantity_atomic ?? "0");
    const equity = BigInt(row.cash_balance_atomic) + notionalAtomic(quantity, price.priceAtomic);
    mark = { priceAtomic: price.priceAtomic.toString(), publishTime: price.publishTime,
      equityAtomic: equity.toString() };
  }
  response.json({ data: { account: {
    id: row.id, state: row.state, assetMint: row.asset_mint, feeAtomic: row.fee_atomic,
    feeSignature: row.fee_signature, initialEquityAtomic: row.initial_equity_atomic,
    cashBalanceAtomic: row.cash_balance_atomic, peakEquityAtomic: row.peak_equity_atomic,
    startedAt: row.started_at, endsAt: row.ends_at, failureReason: row.failure_reason,
    fundedWallet: row.funded_wallet_public_key, fundedAt: row.funded_at,
    fundedHighWaterMarkAtomic: row.funded_high_water_mark_atomic ?? null,
    position: position.rows[0] ? { market, ...position.rows[0] } : { market, quantity_atomic: "0", average_entry_price_atomic: "0" },
    mark,
  }, trades: trades.rows, fundedTrades: fundedTrades.rows, profitSettlements: profitSettlements.rows } });
});

provingGroundRouter.post("/challenges", requireAuth, async (request, response) => {
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new ApiError(400, "idempotency_key_required", "A valid Idempotency-Key header is required.");
  z.object({}).parse(request.body ?? {});
  if (!config.PROVING_GROUND_SOL_USD_FEED_ID) throw new ApiError(503, "proving_ground_unavailable", "Configure the Pyth SOL/USD feed ID before opening challenges.");
  if (!config.PYTH_API_KEY) throw new ApiError(503, "proving_ground_unavailable", "Configure PYTH_API_KEY before opening challenges.");
  const mint = new PublicKey(usdcMint());
  const treasury = new PublicKey(treasuryWallet());
  const payer = loadSolanaFeePayer();
  const sourceOwner = new PublicKey(request.auth!.walletAddress);
  const destination = getAssociatedTokenAddressSync(mint, treasury);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, treasury, mint),
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, sourceOwner), mint, destination, sourceOwner,
      config.PROVING_GROUND_CHALLENGE_FEE_ATOMIC, 6, [], TOKEN_PROGRAM_ID,
    ),
  );
  const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground:${request.auth!.userId}`]);
    const found = await db.query<Account>(
      "SELECT * FROM proving_ground_accounts WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE",
      [request.auth!.userId, idempotencyKey],
    );
    if (found.rows[0]) {
      const foundAccount = found.rows[0];
      const currentHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
      if (foundAccount.state === "awaiting_fee" && foundAccount.fee_last_valid_block_height
        && currentHeight > Number(foundAccount.fee_last_valid_block_height)) {
        await db.query(
          `UPDATE proving_ground_accounts SET fee_unsigned_transaction = $2,
             fee_recent_blockhash = $3, fee_last_valid_block_height = $4, updated_at = now()
           WHERE id = $1`, [foundAccount.id, unsigned, latest.blockhash, latest.lastValidBlockHeight],
        );
        await db.query(
          `INSERT INTO proving_ground_fee_attempts (account_id, unsigned_transaction, recent_blockhash, last_valid_block_height)
           VALUES ($1, $2, $3, $4)`, [foundAccount.id, unsigned, latest.blockhash, latest.lastValidBlockHeight],
        );
        await db.query("COMMIT");
        response.json({ data: { accountId: foundAccount.id, state: "awaiting_fee",
          feeAtomic: foundAccount.fee_atomic, unsignedTransaction: unsigned,
          lastValidBlockHeight: latest.lastValidBlockHeight }, idempotentReplay: true, refreshed: true });
        return;
      }
      await db.query("COMMIT");
      response.json({ data: { accountId: foundAccount.id, state: foundAccount.state,
        feeAtomic: foundAccount.fee_atomic, unsignedTransaction: foundAccount.fee_unsigned_transaction }, idempotentReplay: true });
      return;
    }
    const active = await db.query("SELECT 1 FROM proving_ground_accounts WHERE user_id = $1 AND state IN ('awaiting_fee', 'active', 'passed', 'funding_pending', 'funded') LIMIT 1", [request.auth!.userId]);
    if (active.rowCount) throw new ApiError(409, "proving_ground_account_active", "An existing challenge or funded account must finish before opening another.");
    const dayStart = utcDayStart(new Date());
    const created = await db.query<{ id: string }>(
      `INSERT INTO proving_ground_accounts
         (user_id, idempotency_key, state, cluster, asset_mint, fee_atomic,
          fee_unsigned_transaction, fee_recent_blockhash, fee_last_valid_block_height,
          initial_equity_atomic, cash_balance_atomic, peak_equity_atomic,
          day_open_equity_atomic, day_open_at)
       VALUES ($1, $2, 'awaiting_fee', $3, $4, $5, $6, $7, $8, $9, $9, $9, $9, $10)
       RETURNING id`,
      [request.auth!.userId, idempotencyKey, config.SOLANA_CLUSTER, mint.toBase58(),
        config.PROVING_GROUND_CHALLENGE_FEE_ATOMIC.toString(), unsigned, latest.blockhash,
        latest.lastValidBlockHeight, config.PROVING_GROUND_INITIAL_CAPITAL_ATOMIC.toString(), dayStart],
    );
    await db.query(
      `INSERT INTO proving_ground_fee_attempts (account_id, unsigned_transaction, recent_blockhash, last_valid_block_height)
       VALUES ($1, $2, $3, $4)`, [created.rows[0].id, unsigned, latest.blockhash, latest.lastValidBlockHeight],
    );
    await db.query("COMMIT");
    response.status(201).json({ data: { accountId: created.rows[0].id, state: "awaiting_fee",
      feeAtomic: config.PROVING_GROUND_CHALLENGE_FEE_ATOMIC.toString(), assetMint: mint.toBase58(),
      unsignedTransaction: unsigned, lastValidBlockHeight: latest.lastValidBlockHeight,
      virtualCapitalAtomic: config.PROVING_GROUND_INITIAL_CAPITAL_ATOMIC.toString() } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

provingGroundRouter.post("/challenges/:accountId/fee-confirm", requireAuth, async (request, response) => {
  const accountId = uuid.parse(request.params.accountId);
  const signature = z.string().min(80).max(100).parse(request.body?.signature);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground-account:${accountId}`]);
    const selected = await db.query<Account>(
      "SELECT * FROM proving_ground_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [accountId, request.auth!.userId],
    );
    const account = selected.rows[0];
    if (!account) throw new ApiError(404, "proving_ground_account_not_found", "Proving Ground account not found.");
    if (account.state === "active" && account.fee_signature === signature) {
      await db.query("COMMIT");
      response.json({ data: { accountId, state: "active", startedAt: account.started_at, endsAt: account.ends_at }, idempotentReplay: true });
      return;
    }
    if (account.state !== "awaiting_fee") {
      throw new ApiError(409, "challenge_fee_state_invalid", "This challenge is not awaiting its fee payment.");
    }
    const attempts = await db.query<{ id: string; unsigned_transaction: string }>(
      `SELECT id, unsigned_transaction FROM proving_ground_fee_attempts
        WHERE account_id = $1 AND state = 'awaiting' ORDER BY created_at DESC`, [accountId],
    );
    let matchedAttempt: { id: string; unsigned_transaction: string } | undefined;
    for (const attempt of attempts.rows) {
      try {
        await verifyFeeTransaction({ signature, encoded: attempt.unsigned_transaction, wallet: request.auth!.walletAddress });
        matchedAttempt = attempt;
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "challenge_fee_mismatch") throw error;
      }
    }
    if (!matchedAttempt) throw new ApiError(422, "challenge_fee_mismatch", "The confirmed transaction does not match any prepared fee payment for this challenge.");
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + config.PROVING_GROUND_DURATION_DAYS * 86_400_000);
    await db.query(
      `UPDATE proving_ground_accounts SET state = 'active', fee_signature = $2,
         started_at = $3, ends_at = $4, day_open_at = $3, updated_at = now() WHERE id = $1`,
      [accountId, signature, startedAt, endsAt],
    );
    await db.query(
      "UPDATE proving_ground_fee_attempts SET state = 'confirmed', transaction_signature = $2, updated_at = now() WHERE id = $1",
      [matchedAttempt.id, signature],
    );
    await db.query("COMMIT");
    response.status(201).json({ data: { accountId, state: "active", startedAt, endsAt,
      virtualCapitalAtomic: account.initial_equity_atomic } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

provingGroundRouter.post("/accounts/:accountId/trades", requireAuth, async (request, response) => {
  const accountId = uuid.parse(request.params.accountId);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new ApiError(400, "idempotency_key_required", "A valid Idempotency-Key header is required.");
  const input = z.object({ side: z.enum(["buy", "sell"]), quantity: amountSchema }).parse(request.body);
  const quantity = toTokenAtomic(input.quantity);
  if (quantity <= 0n) throw new ApiError(400, "invalid_quantity", "Trade quantity must be greater than zero.");
  if (!config.PROVING_GROUND_SOL_USD_FEED_ID) throw new ApiError(503, "proving_ground_unavailable", "The Pyth SOL/USD feed is not configured.");
  const oracle = await latestPythPrice(config.PROVING_GROUND_SOL_USD_FEED_ID);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground-account:${accountId}`]);
    const duplicate = await db.query<{ id: string }>(
      "SELECT id FROM proving_ground_trades WHERE account_id = $1 AND user_id = $2 AND idempotency_key = $3",
      [accountId, request.auth!.userId, idempotencyKey],
    );
    if (duplicate.rows[0]) {
      const saved = await db.query("SELECT * FROM proving_ground_trades WHERE id = $1", [duplicate.rows[0].id]);
      await db.query("COMMIT");
      response.json({ data: { trade: saved.rows[0] }, idempotentReplay: true });
      return;
    }
    const selected = await db.query<Account>(
      "SELECT * FROM proving_ground_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [accountId, request.auth!.userId],
    );
    const account = selected.rows[0];
    if (!account) throw new ApiError(404, "proving_ground_account_not_found", "Proving Ground account not found.");
    if (account.state !== "active" || !account.ends_at || account.ends_at <= new Date()) {
      throw new ApiError(409, "proving_ground_not_active", "This challenge is not accepting trades.");
    }
    const current = await db.query<{ quantity_atomic: string; average_entry_price_atomic: string }>(
      `SELECT quantity_atomic::text, average_entry_price_atomic::text FROM proving_ground_positions
        WHERE account_id = $1 AND market = $2 FOR UPDATE`, [accountId, market],
    );
    const oldQuantity = BigInt(current.rows[0]?.quantity_atomic ?? "0");
    const notional = notionalAtomic(quantity, oracle.priceAtomic);
    if (notional <= 0n) throw new ApiError(400, "trade_too_small", "Trade value is below the supported precision.");
    let cash = BigInt(account.cash_balance_atomic);
    let newQuantity = oldQuantity;
    let averagePrice = BigInt(current.rows[0]?.average_entry_price_atomic ?? "0");
    if (input.side === "buy") {
      if (cash < notional) throw new ApiError(409, "virtual_balance_low", "The simulated account does not have enough USDC for this buy.");
      cash -= notional;
      newQuantity += quantity;
      averagePrice = newQuantity === 0n ? 0n : (oldQuantity * averagePrice + quantity * oracle.priceAtomic) / newQuantity;
    } else {
      if (oldQuantity < quantity) throw new ApiError(409, "position_too_small", "The simulated account does not hold enough SOL to sell.");
      newQuantity -= quantity;
      cash += notional;
      if (newQuantity === 0n) averagePrice = 0n;
    }
    const equity = cash + notionalAtomic(newQuantity, oracle.priceAtomic);
    const now = new Date();
    const dayBoundary = utcDayStart(now);
    const dayBoundaryPassed = utcDayStart(account.day_open_at).getTime() !== dayBoundary.getTime();
    let dayOpenEquity = BigInt(account.day_open_equity_atomic);
    if (dayBoundaryPassed) {
      const lastDayMark = await db.query<{ equity_atomic: string }>(
        `SELECT equity_atomic::text FROM proving_ground_marks
          WHERE account_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 1`, [accountId, dayBoundary],
      );
      dayOpenEquity = BigInt(lastDayMark.rows[0]?.equity_atomic
        ?? (BigInt(account.cash_balance_atomic) + notionalAtomic(oldQuantity, oracle.priceAtomic)).toString());
    }
    const peakEquity = BigInt(account.peak_equity_atomic) > equity ? BigInt(account.peak_equity_atomic) : equity;
    const dailyDrawdown = drawdownBps(dayOpenEquity, equity);
    const totalDrawdown = drawdownBps(peakEquity, equity);
    const dailyLimitHit = dayOpenEquity > 0n
      && (dayOpenEquity - equity) * 10_000n >= dayOpenEquity * BigInt(config.PROVING_GROUND_DAILY_DRAWDOWN_BPS);
    const totalLimitHit = peakEquity > 0n
      && (peakEquity - equity) * 10_000n >= peakEquity * BigInt(config.PROVING_GROUND_TOTAL_DRAWDOWN_BPS);
    const failedReason = dailyLimitHit ? "daily_drawdown" : totalLimitHit ? "total_drawdown" : null;
    await db.query(
      `INSERT INTO proving_ground_positions (account_id, market, quantity_atomic, average_entry_price_atomic)
       VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, market) DO UPDATE SET
         quantity_atomic = EXCLUDED.quantity_atomic, average_entry_price_atomic = EXCLUDED.average_entry_price_atomic, updated_at = now()`,
      [accountId, market, newQuantity.toString(), averagePrice.toString()],
    );
    await db.query(
      `UPDATE proving_ground_accounts SET cash_balance_atomic = $2, peak_equity_atomic = $3,
         day_open_equity_atomic = $4, day_open_at = $5,
         state = CASE WHEN $6::text IS NULL THEN state ELSE 'failed' END,
         failure_reason = COALESCE($6, failure_reason), completed_at = CASE WHEN $6::text IS NULL THEN completed_at ELSE now() END,
         updated_at = now() WHERE id = $1`,
      [accountId, cash.toString(), peakEquity.toString(), dayOpenEquity.toString(), dayBoundary, failedReason],
    );
    await db.query(
      `INSERT INTO proving_ground_trades
         (account_id, user_id, idempotency_key, market, side, quantity_atomic,
          price_atomic, notional_atomic, oracle_feed_id, oracle_publish_time,
          cash_balance_after_atomic, position_after_atomic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [accountId, request.auth!.userId, idempotencyKey, market, input.side, quantity.toString(),
        oracle.priceAtomic.toString(), notional.toString(), oracle.feedId, oracle.publishTime,
        cash.toString(), newQuantity.toString()],
    );
    await db.query(
      `INSERT INTO proving_ground_marks
         (account_id, equity_atomic, peak_equity_atomic, day_open_equity_atomic,
          daily_drawdown_bps, total_drawdown_bps, oracle_feed_id, oracle_publish_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, equity.toString(), peakEquity.toString(), dayOpenEquity.toString(),
        dailyDrawdown, totalDrawdown, oracle.feedId, oracle.publishTime],
    );
    await db.query("COMMIT");
    response.status(201).json({ data: { accountId, state: failedReason ? "failed" : "active", market,
      side: input.side, quantityAtomic: quantity.toString(), priceAtomic: oracle.priceAtomic.toString(),
      notionalAtomic: notional.toString(), equityAtomic: equity.toString(),
      dailyDrawdownBasisPoints: dailyDrawdown, totalDrawdownBasisPoints: totalDrawdown,
      failureReason: failedReason, oraclePublishTime: oracle.publishTime } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

export async function reconcileProvingGround(limit = 25) {
  const summary = { examined: 0, marked: 0, passed: 0, failed: 0, errors: [] as { accountId: string; code: string }[] };
  if (!config.PROVING_GROUND_SOL_USD_FEED_ID || !config.PYTH_API_KEY) return summary;
  const oracle = await latestPythPrice(config.PROVING_GROUND_SOL_USD_FEED_ID);
  const due = await pool.query<{ id: string }>(
    `SELECT a.id FROM proving_ground_accounts a
       LEFT JOIN LATERAL (SELECT max(created_at) AS last_mark FROM proving_ground_marks WHERE account_id = a.id) m ON true
      WHERE a.state = 'active' AND (a.ends_at <= now() OR m.last_mark IS NULL OR m.last_mark < now() - interval '1 minute')
      ORDER BY a.ends_at LIMIT $1`, [limit],
  );
  summary.examined = due.rows.length;
  for (const { id } of due.rows) {
    try {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`proving-ground-account:${id}`]);
        const selected = await db.query<Account>("SELECT * FROM proving_ground_accounts WHERE id = $1 FOR UPDATE", [id]);
        const account = selected.rows[0];
        if (!account || account.state !== "active" || !account.ends_at || account.ends_at > new Date()) {
          await db.query("COMMIT");
          continue;
        }
        const position = await db.query<{ quantity_atomic: string }>(
          "SELECT quantity_atomic::text FROM proving_ground_positions WHERE account_id = $1 AND market = $2",
          [id, market],
        );
        const equity = BigInt(account.cash_balance_atomic)
          + notionalAtomic(BigInt(position.rows[0]?.quantity_atomic ?? "0"), oracle.priceAtomic);
        const previousPeak = BigInt(account.peak_equity_atomic);
        const peak = previousPeak > equity ? previousPeak : equity;
        const now = new Date();
        const dayBoundaryPassed = utcDayStart(account.day_open_at).getTime() !== utcDayStart(now).getTime();
        let dayOpenEquity = BigInt(account.day_open_equity_atomic);
        if (dayBoundaryPassed) {
          const lastDayMark = await db.query<{ equity_atomic: string }>(
            `SELECT equity_atomic::text FROM proving_ground_marks
              WHERE account_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 1`, [id, utcDayStart(now)],
          );
          dayOpenEquity = BigInt(lastDayMark.rows[0]?.equity_atomic ?? equity.toString());
        }
        const totalDrawdown = drawdownBps(peak, equity);
        const dailyDrawdown = drawdownBps(dayOpenEquity, equity);
        const dailyLimitHit = dayOpenEquity > 0n
          && (dayOpenEquity - equity) * 10_000n >= dayOpenEquity * BigInt(config.PROVING_GROUND_DAILY_DRAWDOWN_BPS);
        const totalLimitHit = peak > 0n
          && (peak - equity) * 10_000n >= peak * BigInt(config.PROVING_GROUND_TOTAL_DRAWDOWN_BPS);
        const failureReason = totalLimitHit ? "total_drawdown"
          : dailyLimitHit ? "daily_drawdown"
            : account.ends_at <= now
              ? equity * 10_000n >= BigInt(account.initial_equity_atomic) * BigInt(10_000 + config.PROVING_GROUND_TARGET_BPS)
                ? null : "challenge_timeout"
              : null;
        const state = failureReason ? "failed" : account.ends_at <= now ? "passed" : "active";
        await db.query(
          `INSERT INTO proving_ground_marks
             (account_id, equity_atomic, peak_equity_atomic, day_open_equity_atomic,
              daily_drawdown_bps, total_drawdown_bps, oracle_feed_id, oracle_publish_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, equity.toString(), peak.toString(), dayOpenEquity.toString(),
            dailyDrawdown, totalDrawdown, oracle.feedId, oracle.publishTime],
        );
        await db.query(
          `UPDATE proving_ground_accounts SET state = $2, failure_reason = $3,
             completed_at = CASE WHEN $2 IN ('passed', 'failed') THEN now() ELSE NULL END,
             peak_equity_atomic = $4, day_open_equity_atomic = $5, day_open_at = $6,
             updated_at = now() WHERE id = $1`,
          [id, state, failureReason, peak.toString(), dayOpenEquity.toString(),
            dayBoundaryPassed ? utcDayStart(now) : account.day_open_at],
        );
        await db.query("COMMIT");
        summary.marked += 1;
        if (state === "passed") summary.passed += 1;
        else if (state === "failed") summary.failed += 1;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    } catch (error) {
      summary.errors.push({ accountId: id, code: error instanceof ApiError ? error.code : "proving_ground_reconcile_error" });
    }
  }
  return summary;
}

export async function reconcileProvingGroundFundings(limit = 25) {
  const summary = { examined: 0, queued: 0, confirmed: 0, submitted: 0, waitingForPool: 0,
    errors: [] as { operationId: string; code: string }[] };
  const db = await pool.connect();
  let locked = false;
  try {
    const lock = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('guildhall-proving-ground-funding')) AS acquired");
    if (!lock.rows[0]?.acquired) return summary;
    locked = true;
    await db.query("BEGIN");
    const poolRow = await ensureProvingGroundPool(db);
    let balance = await provingPoolBalance(poolRow);
    const reservedResult = await db.query<{ amount_atomic: string }>(
      `SELECT COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
         FROM proving_ground_funding_operations
        WHERE kind = 'allocation' AND state IN ('queued', 'submitted', 'failed')`,
    );
    const reservedBalance = BigInt(reservedResult.rows[0]?.amount_atomic ?? "0");
    balance = balance > reservedBalance ? balance - reservedBalance : 0n;
    const passed = await db.query<Account>(
      `SELECT a.* FROM proving_ground_accounts a
        WHERE a.state = 'passed' AND NOT EXISTS (
          SELECT 1 FROM proving_ground_funding_operations o WHERE o.account_id = a.id AND o.kind = 'allocation'
        ) ORDER BY a.completed_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit],
    );
    for (const account of passed.rows) {
      const amount = BigInt(account.initial_equity_atomic);
      if (balance < amount) { summary.waitingForPool += 1; continue; }
      const wallet = createEncryptedSolanaWallet();
      await db.query(
        `UPDATE proving_ground_accounts SET state = 'funding_pending',
           funded_wallet_public_key = $2, encrypted_funded_wallet_secret_key = $3,
           funded_wallet_encryption_nonce = $4, funded_wallet_encryption_auth_tag = $5,
           funded_wallet_encryption_key_version = $6, updated_at = now() WHERE id = $1`,
        [account.id, wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce,
          wallet.encryptionAuthTag, wallet.encryptionKeyVersion],
      );
      await db.query(
        `INSERT INTO proving_ground_funding_operations (account_id, kind, amount_atomic, destination_wallet)
         VALUES ($1, 'allocation', $2, $3) ON CONFLICT (account_id, kind) DO NOTHING`,
        [account.id, amount.toString(), wallet.publicKey],
      );
      balance -= amount;
      summary.queued += 1;
    }
    await db.query("COMMIT");

    const operations = await db.query<{
      id: string; account_id: string; amount_atomic: string; destination_wallet: string; state: string;
      source_wallet: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
      encryption_auth_tag: Buffer; encryption_key_version: number;
    }>(
      `SELECT o.id, o.account_id, o.amount_atomic::text, o.destination_wallet, o.state,
              p.wallet_public_key AS source_wallet, p.encrypted_secret_key,
              p.encryption_nonce, p.encryption_auth_tag, p.encryption_key_version
         FROM proving_ground_funding_operations o CROSS JOIN proving_ground_pool p
        WHERE o.kind = 'allocation' AND o.state IN ('queued', 'submitted', 'failed')
        ORDER BY o.created_at LIMIT $1`, [limit],
    );
    summary.examined = operations.rows.length;
    for (const operation of operations.rows) {
      try {
        const attempts = await db.query<FundingAttempt>(
          `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
             FROM proving_ground_funding_attempts WHERE operation_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
        );
        let attempt: FundingAttempt | undefined = attempts.rows[0];
        if (attempt && ["prepared", "submitted", "expired"].includes(attempt.state)) {
          const status = (await connection.getSignatureStatuses([attempt.transaction_signature], { searchTransactionHistory: true })).value[0];
          if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await db.query("UPDATE proving_ground_funding_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [attempt.id]);
            await db.query("UPDATE proving_ground_funding_operations SET state = 'queued', updated_at = now() WHERE id = $1", [operation.id]);
            attempt = undefined;
          } else if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
            await markFundingConfirmed(operation.id, attempt);
            summary.confirmed += 1;
            continue;
          } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(attempt.last_valid_block_height)) {
            await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
            await db.query("UPDATE proving_ground_funding_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
            await db.query("UPDATE proving_ground_funding_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
            summary.submitted += 1;
            break;
          } else {
            throw new ApiError(409, "proving_ground_allocation_outcome_unknown", "The pool allocation expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
          }
        }
        if (!attempt || ["failed", "expired"].includes(attempt.state)) {
          const sourceOwner = new PublicKey(operation.source_wallet);
          const destinationOwner = new PublicKey(operation.destination_wallet);
          const mint = new PublicKey(usdcMint());
          const source = getAssociatedTokenAddressSync(mint, sourceOwner);
          const sourceInfo = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
          if (!sourceInfo || BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount) < BigInt(operation.amount_atomic)) {
            summary.waitingForPool += 1;
            continue;
          }
          const secret = decryptSolanaSecretKey({ ciphertext: operation.encrypted_secret_key,
            nonce: operation.encryption_nonce, authTag: operation.encryption_auth_tag,
            keyVersion: operation.encryption_key_version });
          const sourceKey = Keypair.fromSecretKey(secret);
          if (!sourceKey.publicKey.equals(sourceOwner)) throw new Error("Proving Ground pool key does not match its recorded address.");
          const payer = loadSolanaFeePayer();
          const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
          const destination = getAssociatedTokenAddressSync(mint, destinationOwner);
          const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, destinationOwner, mint),
            createTransferCheckedInstruction(source, mint, destination, sourceOwner,
              BigInt(operation.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
          );
          transaction.partialSign(payer, sourceKey);
          if (!transaction.signature) throw new Error("Proving Ground funding transaction has no signature.");
          const signature = bs58.encode(transaction.signature);
          const signedTransaction = transaction.serialize();
          const saved = await db.query<{ id: string }>(
            `INSERT INTO proving_ground_funding_attempts
               (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
             VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
            [operation.id, signature, signedTransaction, latest.blockhash, latest.lastValidBlockHeight],
          );
          attempt = { id: saved.rows[0].id, transaction_signature: signature,
            signed_transaction: signedTransaction, last_valid_block_height: String(latest.lastValidBlockHeight), state: "prepared" };
        }
        await connection.sendRawTransaction(attempt.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE proving_ground_funding_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [attempt.id]);
        await db.query("UPDATE proving_ground_funding_operations SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, attempt.transaction_signature]);
        summary.submitted += 1;
        break;
      } catch (error) {
        summary.errors.push({ operationId: operation.id,
          code: error instanceof ApiError ? error.code : "proving_ground_funding_error" });
      }
    }
    return summary;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('guildhall-proving-ground-funding'))").catch(() => undefined);
    db.release();
  }
}
