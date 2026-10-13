import { Router } from "express";
import { PublicKey, Transaction, Connection } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { assignUnassignedWardens } from "../tribunal.js";
import { withdrawEvaluatorStake } from "../evaluator-staking.js";

export const evaluatorsRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const walletSchema = z.string().min(32).max(44);
const depositInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const signatureSchema = z.string().min(80).max(100);

function canonicalWallet(value: string) {
  try { return new PublicKey(value).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
}

function toAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (value <= 0n) throw new ApiError(400, "invalid_amount", "Stake deposit must be greater than zero.");
  return value;
}

async function getOrCreateStakeWallet(userId: string) {
  if (!config.USDC_MINT) throw new ApiError(503, "stake_asset_unavailable", "USDC stake mint is not configured.");
  const mint = canonicalWallet(config.USDC_MINT);
  const existing = await pool.query<{ stake_wallet_public_key: string }>(
    "SELECT stake_wallet_public_key FROM evaluator_profiles WHERE user_id = $1", [userId],
  );
  if (existing.rows[0]) return existing.rows[0].stake_wallet_public_key;
  const key = createEncryptedSolanaWallet();
  const inserted = await pool.query<{ stake_wallet_public_key: string }>(
    `INSERT INTO evaluator_profiles
       (user_id, stake_wallet_public_key, encrypted_secret_key, encryption_nonce,
        encryption_auth_tag, encryption_key_version, cluster, stake_mint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id) DO NOTHING RETURNING stake_wallet_public_key`,
    [userId, key.publicKey, key.encryptedSecretKey, key.encryptionNonce, key.encryptionAuthTag,
      key.encryptionKeyVersion, config.SOLANA_CLUSTER, mint],
  );
  if (inserted.rows[0]) return inserted.rows[0].stake_wallet_public_key;
  const raced = await pool.query<{ stake_wallet_public_key: string }>(
    "SELECT stake_wallet_public_key FROM evaluator_profiles WHERE user_id = $1", [userId],
  );
  if (!raced.rows[0]) throw new Error("Could not create or load evaluator stake wallet.");
  return raced.rows[0].stake_wallet_public_key;
}

evaluatorsRouter.post("/stake-instructions", requireAuth, async (request, response) => {
  const { amount } = z.object({ amount: depositInput }).parse(request.body);
  const amountAtomic = toAtomic(amount);
  const stakeAddress = await getOrCreateStakeWallet(request.auth!.userId);
  const mint = new PublicKey(config.USDC_MINT!);
  const depositor = new PublicKey(request.auth!.walletAddress);
  const stakeWallet = new PublicKey(stakeAddress);
  const source = getAssociatedTokenAddressSync(mint, depositor);
  const destination = getAssociatedTokenAddressSync(mint, stakeWallet);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: depositor, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(depositor, source, depositor, mint),
    createAssociatedTokenAccountIdempotentInstruction(depositor, destination, stakeWallet, mint),
    createTransferCheckedInstruction(source, mint, destination, depositor, amountAtomic, 6, [], TOKEN_PROGRAM_ID),
  );
  response.json({ data: {
    cluster: config.SOLANA_CLUSTER, stakeWallet: stakeAddress, mint: mint.toBase58(), amountAtomic: amountAtomic.toString(),
    unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  } });
});

evaluatorsRouter.post("/stake-confirm", requireAuth, async (request, response) => {
  const { signature } = z.object({ signature: signatureSchema }).parse(request.body);
  let signatureBytes: Uint8Array;
  try { signatureBytes = bs58.decode(signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (signatureBytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const stakeAddress = await getOrCreateStakeWallet(request.auth!.userId);
  const stake = await pool.query<{ stake_mint: string; stake_atomic: string }>(
    "SELECT stake_mint, stake_atomic FROM evaluator_profiles WHERE user_id = $1", [request.auth!.userId],
  );
  if (!stake.rows[0]) throw new ApiError(409, "stake_wallet_missing", "An evaluator stake wallet was not created.");
  const existing = await pool.query<{ amount_atomic: string }>(
    "SELECT amount_atomic FROM evaluator_stake_deposits WHERE signature = $1 AND user_id = $2", [signature, request.auth!.userId],
  );
  if (existing.rows[0]) {
    response.json({ data: { stakeWallet: stakeAddress, depositAtomic: existing.rows[0].amount_atomic, idempotentReplay: true } });
    return;
  }
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "stake_deposit_unconfirmed", "The stake deposit is not confirmed on this cluster.");
  }
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "stake_transaction_unavailable", "The confirmed deposit details are not available yet.");
  const wallet = request.auth!.walletAddress;
  const mint = stake.rows[0].stake_mint;
  const signedByDepositor = parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer);
  if (!signedByDepositor) throw new ApiError(422, "stake_depositor_mismatch", "The signed-in wallet did not authorize this deposit.");
  const tokenBalances = parsed.meta.postTokenBalances ?? [];
  const stakeTokenBalance = tokenBalances.find((balance) => balance.mint === mint && balance.owner === stakeAddress);
  if (!stakeTokenBalance || stakeTokenBalance.uiTokenAmount.decimals !== 6) {
    throw new ApiError(422, "stake_asset_mismatch", "The deposit did not fund the evaluator's USDC stake account.");
  }
  const postStake = BigInt(stakeTokenBalance.uiTokenAmount.amount);
  const preStake = BigInt((parsed.meta.preTokenBalances ?? []).find(
    (balance) => balance.accountIndex === stakeTokenBalance.accountIndex && balance.mint === mint,
  )?.uiTokenAmount.amount ?? "0");
  const deposited = postStake - preStake;
  if (deposited <= 0n) throw new ApiError(422, "stake_amount_mismatch", "The transaction did not add stake to the evaluator account.");
  const sourceDelta = tokenBalances.filter((balance) => balance.mint === mint && balance.owner === wallet).reduce((sum, post) => {
    const pre = (parsed.meta!.preTokenBalances ?? []).find((balance) => balance.accountIndex === post.accountIndex && balance.mint === mint);
    return sum + BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
  }, 0n);
  if (sourceDelta !== -deposited) throw new ApiError(422, "stake_source_mismatch", "The stake must be deposited from the signed-in wallet.");

  const client = await pool.connect();
  let balanceAtomic = 0n;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evaluator-stake:${request.auth!.userId}`]);
    const currentBalance = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(stakeAddress)), config.SOLANA_COMMITMENT,
    );
    balanceAtomic = BigInt(currentBalance.value.amount);
    await client.query(
      `INSERT INTO evaluator_stake_deposits (signature, user_id, source_wallet, amount_atomic)
       VALUES ($1, $2, $3, $4)`, [signature, request.auth!.userId, wallet, deposited.toString()],
    );
    await client.query(
      `UPDATE evaluator_profiles SET stake_atomic = $2, active = ($2::numeric > 0), updated_at = now()
       WHERE user_id = $1`, [request.auth!.userId, balanceAtomic.toString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const assignedWardens = await assignUnassignedWardens(25);
  response.json({ data: { stakeWallet: stakeAddress, depositAtomic: deposited.toString(), stakeAtomic: balanceAtomic.toString(), active: true, assignedWardens } });
});

evaluatorsRouter.get("/me", requireAuth, async (request, response) => {
  const result = await pool.query<{
    stake_wallet_public_key: string; stake_mint: string; stake_atomic: string;
    active: boolean; max_concurrent_cases: number; registered_at: Date;
  }>(
    `SELECT stake_wallet_public_key, stake_mint, stake_atomic, active, max_concurrent_cases, registered_at
       FROM evaluator_profiles WHERE user_id = $1`, [request.auth!.userId],
  );
  response.json({ data: result.rows[0] ?? null });
});

evaluatorsRouter.post("/withdraw", requireAuth, async (request, response) => {
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const result = await withdrawEvaluatorStake(request.auth!.userId, idempotencyKey);
  response.status(result.state === "confirmed" ? 200 : 202).json({ data: result });
});
