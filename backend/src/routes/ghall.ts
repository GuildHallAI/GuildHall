import { Router } from "express";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { evaluatorCapacityAtomic, ghallBalanceAtomic } from "../ghall.js";
import { createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { decryptSolanaSecretKey } from "../escrow-wallets.js";
import { loadSolanaFeePayer } from "../solana-fee-payer.js";
import { ApiError } from "../http.js";
import { tokenOwnerBalanceDelta } from "../solana-token-balance.js";

export const ghallRouter = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const atomicSchema = z.string().regex(/^[1-9]\d{0,29}$/);
const signatureSchema = z.string().min(80).max(100);

async function configuredGhallMint() {
  if (!config.GHALL_MINT) throw new ApiError(503, "ghall_unavailable", "$GHALL is not configured on this cluster.");
  const mint = new PublicKey(config.GHALL_MINT);
  const info = await getMint(connection, mint, config.SOLANA_COMMITMENT, TOKEN_2022_PROGRAM_ID);
  if (info.decimals !== 9 || getExtensionTypes(info.tlvData).length !== 0) {
    throw new ApiError(503, "ghall_mint_invalid", "$GHALL must be a 9-decimal Token-2022 mint without extensions.");
  }
  return mint;
}

async function getOrCreateStakeAccount(userId: string, mint: string) {
  const existing = await pool.query<{ stake_wallet_public_key: string; mint: string }>(
    "SELECT stake_wallet_public_key, mint FROM ghall_stake_accounts WHERE user_id = $1", [userId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].mint !== mint) throw new ApiError(409, "ghall_cluster_mismatch", "This stake account belongs to a different GHALL mint.");
    return existing.rows[0].stake_wallet_public_key;
  }
  const wallet = createEncryptedSolanaWallet();
  await pool.query(
    `INSERT INTO ghall_stake_accounts
       (user_id, stake_wallet_public_key, encrypted_secret_key, encryption_nonce,
        encryption_auth_tag, encryption_key_version, cluster, mint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id) DO NOTHING`,
    [userId, wallet.publicKey, wallet.encryptedSecretKey, wallet.encryptionNonce,
      wallet.encryptionAuthTag, wallet.encryptionKeyVersion, config.SOLANA_CLUSTER, mint],
  );
  const created = await pool.query<{ stake_wallet_public_key: string }>(
    "SELECT stake_wallet_public_key FROM ghall_stake_accounts WHERE user_id = $1 AND mint = $2", [userId, mint],
  );
  if (!created.rows[0]) throw new Error("Could not create or load the GHALL stake EOA.");
  return created.rows[0].stake_wallet_public_key;
}

ghallRouter.get("/me", requireAuth, async (request, response) => {
  const balance = await ghallBalanceAtomic(request.auth!.walletAddress);
  let walletBalance = 0n;
  let stakedBalance = 0n;
  if (config.GHALL_MINT) {
    const mint = new PublicKey(config.GHALL_MINT);
    const walletAta = getAssociatedTokenAddressSync(mint, new PublicKey(request.auth!.walletAddress), false, TOKEN_2022_PROGRAM_ID);
    if (await connection.getAccountInfo(walletAta, config.SOLANA_COMMITMENT)) {
      walletBalance = BigInt((await connection.getTokenAccountBalance(walletAta, config.SOLANA_COMMITMENT)).value.amount);
    }
    const stake = await pool.query<{ stake_wallet_public_key: string }>(
      `SELECT s.stake_wallet_public_key FROM ghall_stake_accounts s JOIN wallet_users u ON u.id = s.user_id
        WHERE s.user_id = $1 AND s.mint = $2`, [request.auth!.userId, mint.toBase58()],
    );
    if (stake.rows[0]) {
      const stakeAta = getAssociatedTokenAddressSync(mint, new PublicKey(stake.rows[0].stake_wallet_public_key), false, TOKEN_2022_PROGRAM_ID);
      if (await connection.getAccountInfo(stakeAta, config.SOLANA_COMMITMENT)) {
        stakedBalance = BigInt((await connection.getTokenAccountBalance(stakeAta, config.SOLANA_COMMITMENT)).value.amount);
      }
    }
  }
  const evaluator = await pool.query<{ stake_atomic: string; active: boolean }>(
    "SELECT stake_atomic::text, active FROM evaluator_profiles WHERE user_id = $1", [request.auth!.userId],
  );
  const stakeAtomic = evaluator.rows[0]?.stake_atomic ?? "0";
  const capacityAtomic = await evaluatorCapacityAtomic(request.auth!.walletAddress, stakeAtomic);
  const enabled = Boolean(config.GHALL_MINT && config.GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC > 0n
    && config.GHALL_EVALUATOR_MAX_CAPACITY_BPS > 10_000);
  response.json({ data: {
    mint: config.GHALL_MINT ?? null,
    balanceAtomic: balance.toString(),
    walletBalanceAtomic: walletBalance.toString(),
    stakedBalanceAtomic: stakedBalance.toString(),
    evaluator: evaluator.rows[0] ? {
      active: evaluator.rows[0].active,
      usdcStakeAtomic: stakeAtomic,
      effectiveCapacityAtomic: capacityAtomic.toString(),
      boostEnabled: enabled && balance >= config.GHALL_EVALUATOR_BOOST_THRESHOLD_ATOMIC,
      maximumCapacityBasisPoints: config.GHALL_EVALUATOR_MAX_CAPACITY_BPS,
    } : null,
  } });
});

ghallRouter.post("/stake-instructions", requireAuth, async (request, response) => {
  const { amountAtomic } = z.object({ amountAtomic: atomicSchema }).parse(request.body);
  const mint = await configuredGhallMint();
  const pending = await pool.query(
    "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1", [request.auth!.userId],
  );
  if (pending.rowCount) throw new ApiError(409, "ghall_withdrawal_pending", "A GHALL withdrawal is already being processed for this wallet.");
  const userWallet = new PublicKey(request.auth!.walletAddress);
  const stakeWallet = new PublicKey(await getOrCreateStakeAccount(request.auth!.userId, mint.toBase58()));
  const source = getAssociatedTokenAddressSync(mint, userWallet, false, TOKEN_2022_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, stakeWallet, false, TOKEN_2022_PROGRAM_ID);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: userWallet, ...latest }).add(
    createAssociatedTokenAccountIdempotentInstruction(userWallet, source, userWallet, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(userWallet, destination, stakeWallet, mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(source, mint, destination, userWallet, BigInt(amountAtomic), 9, [], TOKEN_2022_PROGRAM_ID),
  );
  response.json({ data: {
    mint: mint.toBase58(), stakeWallet: stakeWallet.toBase58(), amountAtomic,
    unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  } });
});

ghallRouter.post("/stake-confirm", requireAuth, async (request, response) => {
  const { signature } = z.object({ signature: signatureSchema }).parse(request.body);
  let bytes: Uint8Array;
  try { bytes = bs58.decode(signature); }
  catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (bytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const mint = await configuredGhallMint();
  const stakeWallet = await getOrCreateStakeAccount(request.auth!.userId, mint.toBase58());
  const pending = await pool.query(
    "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1", [request.auth!.userId],
  );
  if (pending.rowCount) throw new ApiError(409, "ghall_withdrawal_pending", "A GHALL withdrawal is already being processed for this wallet.");
  const prior = await pool.query<{ amount_atomic: string }>(
    "SELECT amount_atomic::text FROM ghall_stake_deposits WHERE signature = $1 AND user_id = $2", [signature, request.auth!.userId],
  );
  if (prior.rows[0]) {
    const balance = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mint, new PublicKey(stakeWallet), false, TOKEN_2022_PROGRAM_ID), config.SOLANA_COMMITMENT,
    );
    response.json({ data: { depositAtomic: prior.rows[0].amount_atomic, stakeAtomic: balance.value.amount, idempotentReplay: true } });
    return;
  }
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new ApiError(409, "ghall_deposit_unconfirmed", "The GHALL stake deposit is not confirmed on this cluster.");
  }
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "ghall_transaction_unavailable", "The confirmed deposit details are not available yet.");
  const wallet = request.auth!.walletAddress;
  if (!parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer)) {
    throw new ApiError(422, "ghall_depositor_mismatch", "The signed-in wallet did not authorize this deposit.");
  }
  const tokenBalances = parsed.meta.postTokenBalances ?? [];
  const destination = tokenBalances.find((balance) => balance.mint === mint.toBase58() && balance.owner === stakeWallet);
  if (!destination || destination.uiTokenAmount.decimals !== 9) {
    throw new ApiError(422, "ghall_mint_mismatch", "The transaction did not fund the GHALL stake account.");
  }
  const before = (parsed.meta.preTokenBalances ?? []).find((balance) => balance.accountIndex === destination.accountIndex && balance.mint === mint.toBase58());
  const deposited = BigInt(destination.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
  const sourceDelta = tokenOwnerBalanceDelta(parsed.meta.preTokenBalances ?? [], tokenBalances, mint.toBase58(), wallet);
  if (deposited <= 0n || sourceDelta !== -deposited) {
    throw new ApiError(422, "ghall_amount_mismatch", "The GHALL deposit must transfer the exact amount from the signed-in wallet to its stake account.");
  }
  const destinationAta = getAssociatedTokenAddressSync(mint, new PublicKey(stakeWallet), false, TOKEN_2022_PROGRAM_ID);
  const balance = await connection.getTokenAccountBalance(destinationAta, config.SOLANA_COMMITMENT);
  const db = await pool.connect();
  let idempotentReplay = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]);
    const withdrawal = await db.query(
      "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1",
      [request.auth!.userId],
    );
    if (withdrawal.rowCount) throw new ApiError(409, "ghall_withdrawal_pending", "A GHALL withdrawal is already being processed for this wallet.");
    const inserted = await db.query(
      `INSERT INTO ghall_stake_deposits (signature, user_id, source_wallet, amount_atomic)
       VALUES ($1, $2, $3, $4) ON CONFLICT (signature) DO NOTHING RETURNING signature`,
      [signature, request.auth!.userId, wallet, deposited.toString()],
    );
    if (!inserted.rowCount) {
      const existing = await db.query("SELECT 1 FROM ghall_stake_deposits WHERE signature = $1 AND user_id = $2", [signature, request.auth!.userId]);
      if (!existing.rowCount) throw new ApiError(409, "ghall_signature_used", "This Solana transaction was already recorded for another wallet.");
      idempotentReplay = true;
    }
    await db.query("UPDATE ghall_stake_accounts SET stake_atomic = $2, updated_at = now() WHERE user_id = $1", [request.auth!.userId, balance.value.amount]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  response.status(idempotentReplay ? 200 : 201).json({ data: { stakeWallet, depositAtomic: deposited.toString(), stakeAtomic: balance.value.amount, idempotentReplay } });
});

ghallRouter.post("/withdraw", requireAuth, async (request, response) => {
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const mint = await configuredGhallMint();
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]);
    locked = true;
    const account = await db.query<{
      stake_wallet_public_key: string; encrypted_secret_key: Buffer; encryption_nonce: Buffer;
      encryption_auth_tag: Buffer; encryption_key_version: number;
    }>(
      `SELECT stake_wallet_public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag, encryption_key_version
         FROM ghall_stake_accounts WHERE user_id = $1 AND mint = $2`, [request.auth!.userId, mint.toBase58()],
    );
    const stake = account.rows[0];
    if (!stake) throw new ApiError(404, "ghall_stake_not_found", "No GHALL stake is available to withdraw.");
    const listing = await db.query("SELECT 1 FROM ghall_listing_allocations WHERE user_id = $1 AND active = true", [request.auth!.userId]);
    if (listing.rowCount) throw new ApiError(409, "ghall_listing_active", "Release the front-page listing allocation before withdrawing GHALL.");
    const voting = await db.query(
      `SELECT 1 FROM ghall_governance_votes v JOIN ghall_governance_proposals p ON p.id = v.proposal_id
        WHERE v.user_id = $1 AND p.state = 'open' AND p.voting_closes_at > now() LIMIT 1`, [request.auth!.userId],
    );
    if (voting.rowCount) throw new ApiError(409, "ghall_vote_in_progress", "GHALL stake is locked while Tribunal rule voting is open.");
    let operation = (await db.query<{
      id: string; amount_atomic: string; state: string; transaction_signature: string | null;
    }>(
      "SELECT id, amount_atomic::text, state, transaction_signature FROM ghall_stake_withdrawals WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE",
      [request.auth!.userId, idempotencyKey],
    )).rows[0];
    if (operation?.state === "confirmed") {
      response.json({ data: { state: operation.state, signature: operation.transaction_signature, amountAtomic: operation.amount_atomic } });
      return;
    }
    if (!operation) {
      const inFlight = await db.query(
        "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1",
        [request.auth!.userId],
      );
      if (inFlight.rowCount) throw new ApiError(409, "ghall_withdrawal_in_progress", "Resolve the current GHALL withdrawal before creating another one.");
    }
    let previous = operation ? (await db.query<{
      id: string; transaction_signature: string; signed_transaction: Buffer; last_valid_block_height: string; state: string;
    }>(
      `SELECT id, transaction_signature, signed_transaction, last_valid_block_height::text, state
         FROM ghall_stake_withdrawal_attempts WHERE withdrawal_id = $1 ORDER BY created_at DESC LIMIT 1`, [operation.id],
    )).rows[0] : undefined;
    if (previous && ["prepared", "submitted", "expired", "outcome_unknown"].includes(previous.state)) {
      const status = (await connection.getSignatureStatuses([previous.transaction_signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [previous.id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'confirmed', updated_at = now() WHERE id = $1", [operation!.id]);
        await db.query("UPDATE ghall_stake_accounts SET stake_atomic = 0, updated_at = now() WHERE user_id = $1", [request.auth!.userId]);
        response.json({ data: { state: "confirmed", signature: previous.transaction_signature, amountAtomic: operation!.amount_atomic } });
        return;
      }
      if ((!status || !status.err) && await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(previous.last_valid_block_height)) {
        await connection.sendRawTransaction(previous.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [previous.id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation!.id, previous.transaction_signature]);
        response.status(202).json({ data: { state: "submitted", signature: previous.transaction_signature, amountAtomic: operation!.amount_atomic } });
        return;
      }
      if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [previous.id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'failed', updated_at = now() WHERE id = $1", [operation!.id]);
        previous = undefined;
      } else {
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [previous.id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'outcome_unknown' WHERE id = $1", [operation!.id]);
        throw new ApiError(409, "ghall_withdrawal_outcome_unknown", "The GHALL withdrawal expired without a verifiable Solana result. The original transaction will be checked again before any replacement is prepared.");
      }
    }
    const source = getAssociatedTokenAddressSync(mint, new PublicKey(stake.stake_wallet_public_key), false, TOKEN_2022_PROGRAM_ID);
    const tokenAccount = await connection.getAccountInfo(source, config.SOLANA_COMMITMENT);
    const amount = tokenAccount ? BigInt((await connection.getTokenAccountBalance(source, config.SOLANA_COMMITMENT)).value.amount) : 0n;
    if (amount <= 0n) throw new ApiError(409, "ghall_stake_empty", "The GHALL stake account has no tokens to withdraw.");
    if (!operation) {
      operation = (await db.query<{ id: string; amount_atomic: string; state: string; transaction_signature: string | null }>(
        `INSERT INTO ghall_stake_withdrawals (user_id, idempotency_key, destination_wallet, amount_atomic)
         VALUES ($1, $2, $3, $4) RETURNING id, amount_atomic::text, state, transaction_signature`,
        [request.auth!.userId, idempotencyKey, request.auth!.walletAddress, amount.toString()],
      )).rows[0];
    } else if (BigInt(operation.amount_atomic) !== amount) {
      throw new ApiError(409, "ghall_balance_changed", "The GHALL stake balance changed after this withdrawal request was created.");
    }
    const recipient = new PublicKey(request.auth!.walletAddress);
    const destination = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
    const feePayer = loadSolanaFeePayer();
    const secret = decryptSolanaSecretKey({ ciphertext: stake.encrypted_secret_key, nonce: stake.encryption_nonce,
      authTag: stake.encryption_auth_tag, keyVersion: stake.encryption_key_version });
    const stakeKey = Keypair.fromSecretKey(secret);
    if (!stakeKey.publicKey.equals(new PublicKey(stake.stake_wallet_public_key))) throw new Error("GHALL stake key does not match its recorded address.");
    const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
    const transaction = new Transaction({ feePayer: feePayer.publicKey, ...latest }).add(
      createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, destination, recipient, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(source, mint, destination, stakeKey.publicKey, BigInt(operation.amount_atomic), 9, [], TOKEN_2022_PROGRAM_ID),
      createCloseAccountInstruction(source, recipient, stakeKey.publicKey, [], TOKEN_2022_PROGRAM_ID),
    );
    transaction.partialSign(feePayer, stakeKey);
    if (!transaction.signature) throw new Error("Signed GHALL withdrawal has no transaction signature.");
    const signature = bs58.encode(transaction.signature);
    const saved = await db.query<{ id: string }>(
      `INSERT INTO ghall_stake_withdrawal_attempts
         (withdrawal_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
       VALUES ($1, $2, $3, $4, $5, 'prepared') RETURNING id`,
      [operation.id, signature, transaction.serialize(), latest.blockhash, latest.lastValidBlockHeight],
    );
    await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
    await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [saved.rows[0].id]);
    await db.query("UPDATE ghall_stake_withdrawals SET state = 'submitted', transaction_signature = $2, updated_at = now() WHERE id = $1", [operation.id, signature]);
    response.status(202).json({ data: { state: "submitted", signature, amountAtomic: operation.amount_atomic } });
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]).catch(() => undefined);
    db.release();
  }
});

ghallRouter.get("/front-page", async (_request, response) => {
  const listings = await pool.query(
    `SELECT a.agent_asset AS "agentAsset", a.amount_atomic::text AS "stakedAtomic", a.updated_at AS "updatedAt",
            u.wallet_address AS "ownerWallet"
       FROM ghall_listing_allocations a
       JOIN wallet_registry_agents r ON r.user_id = a.user_id AND r.agent_asset = a.agent_asset
       JOIN wallet_users u ON u.id = a.user_id
      WHERE a.active = true AND a.amount_atomic >= $1::numeric
      ORDER BY a.amount_atomic DESC, a.updated_at ASC LIMIT 100`,
    [config.GHALL_LISTING_MINIMUM_STAKE_ATOMIC.toString()],
  );
  response.json({ data: listings.rows, minimumStakeAtomic: config.GHALL_LISTING_MINIMUM_STAKE_ATOMIC.toString() });
});

ghallRouter.put("/listing", requireAuth, async (request, response) => {
  if (config.GHALL_LISTING_MINIMUM_STAKE_ATOMIC <= 0n) {
    throw new ApiError(503, "ghall_listing_unconfigured", "The front-page listing stake requirement is not configured.");
  }
  const { agentAsset, amountAtomic } = z.object({
    agentAsset: z.string().min(32).max(44), amountAtomic: atomicSchema,
  }).parse(request.body);
  const mint = await configuredGhallMint();
  let asset: string;
  try { asset = new PublicKey(agentAsset).toBase58(); }
  catch { throw new ApiError(400, "invalid_registry_asset", "A valid Solana Agent Registry asset address is required."); }
  const owner = await pool.query(
    "SELECT 1 FROM wallet_registry_agents WHERE user_id = $1 AND agent_asset = $2", [request.auth!.userId, asset],
  );
  if (!owner.rowCount) throw new ApiError(403, "registry_asset_not_linked", "Link an Agent Registry asset to this wallet before listing it.");
  const account = await pool.query<{ stake_wallet_public_key: string }>(
    "SELECT stake_wallet_public_key FROM ghall_stake_accounts WHERE user_id = $1 AND mint = $2",
    [request.auth!.userId, mint.toBase58()],
  );
  if (!account.rows[0]) throw new ApiError(409, "ghall_stake_required", "Deposit GHALL before reserving a front-page listing.");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]);
    const freshBalance = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mint, new PublicKey(account.rows[0].stake_wallet_public_key), false, TOKEN_2022_PROGRAM_ID),
      config.SOLANA_COMMITMENT,
    );
    const prior = await db.query<{ amount_atomic: string; active: boolean }>(
      "SELECT amount_atomic::text, active FROM ghall_listing_allocations WHERE user_id = $1 FOR UPDATE", [request.auth!.userId],
    );
    const available = BigInt(freshBalance.value.amount) - (prior.rows[0]?.active ? BigInt(prior.rows[0].amount_atomic) : 0n);
    const requested = BigInt(amountAtomic);
    if (requested < config.GHALL_LISTING_MINIMUM_STAKE_ATOMIC || requested > available) {
      throw new ApiError(409, "ghall_listing_stake_insufficient", "The listing allocation must meet the configured minimum and fit within unallocated GHALL stake.");
    }
    const saved = await db.query(
      `INSERT INTO ghall_listing_allocations (user_id, agent_asset, amount_atomic, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id) DO UPDATE SET agent_asset = EXCLUDED.agent_asset, amount_atomic = EXCLUDED.amount_atomic,
         active = true, updated_at = now() RETURNING agent_asset, amount_atomic::text AS amount_atomic, active`,
      [request.auth!.userId, asset, requested.toString()],
    );
    await db.query("COMMIT");
    response.json({ data: saved.rows[0] });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

ghallRouter.delete("/listing", requireAuth, async (request, response) => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]);
    await db.query("UPDATE ghall_listing_allocations SET active = false, updated_at = now() WHERE user_id = $1", [request.auth!.userId]);
    await db.query("COMMIT");
    response.json({ data: { active: false } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

ghallRouter.get("/proposals", async (_request, response) => {
  const result = await pool.query(
    `SELECT p.id, p.title, p.description, p.rule_key AS "ruleKey", p.proposed_value AS "proposedValue",
            p.quorum_atomic::text AS "quorumAtomic", p.yes_atomic::text AS "yesAtomic", p.no_atomic::text AS "noAtomic",
            p.voting_opens_at AS "votingOpensAt", p.voting_closes_at AS "votingClosesAt", p.state,
            s.value AS "enactedValue"
       FROM ghall_governance_proposals p LEFT JOIN ghall_governance_settings s ON s.proposal_id = p.id
      ORDER BY p.created_at DESC LIMIT 100`,
  );
  response.json({ data: result.rows });
});

ghallRouter.post("/proposals", requireAuth, async (request, response) => {
  if (config.GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC <= 0n) {
    throw new ApiError(503, "ghall_governance_unconfigured", "Tribunal rule governance is not configured.");
  }
  const input = z.object({
    title: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(10000),
    ruleKey: z.enum(["warden_appeal_hours", "panel_appeal_hours"]),
    proposedValue: z.number().int().min(1).max(168),
  }).parse(request.body);
  const account = await pool.query<{ stake_atomic: string }>(
    "SELECT stake_atomic::text FROM ghall_stake_accounts WHERE user_id = $1 AND mint = $2",
    [request.auth!.userId, config.GHALL_MINT ?? ""],
  );
  if (!account.rows[0] || BigInt(account.rows[0].stake_atomic) < config.GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC) {
    throw new ApiError(403, "ghall_stake_required", "GHALL stake equal to the configured governance threshold is required to propose a Tribunal rule change.");
  }
  const pendingWithdrawal = await pool.query(
    "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1", [request.auth!.userId],
  );
  if (pendingWithdrawal.rowCount) throw new ApiError(409, "ghall_withdrawal_pending", "A wallet with a pending withdrawal cannot create a governance proposal.");
  const proposal = await pool.query<{ id: string; voting_closes_at: Date }>(
    `INSERT INTO ghall_governance_proposals
       (title, description, rule_key, proposed_value, quorum_atomic, voting_opens_at, voting_closes_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(days => $6), $7)
     RETURNING id, voting_closes_at`,
    [input.title, input.description, input.ruleKey, input.proposedValue,
      config.GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC.toString(), config.GHALL_GOVERNANCE_VOTING_DAYS, request.auth!.walletAddress],
  );
  response.status(201).json({ data: { ...input, id: proposal.rows[0].id,
    quorumAtomic: config.GHALL_GOVERNANCE_MIN_QUORUM_ATOMIC.toString(),
    votingClosesAt: proposal.rows[0].voting_closes_at,
  } });
});

ghallRouter.post("/proposals/:proposalId/votes", requireAuth, async (request, response) => {
  const proposalId = z.string().uuid().parse(request.params.proposalId);
  const { vote } = z.object({ vote: z.enum(["yes", "no"]) }).parse(request.body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-proposal:${proposalId}`]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-stake:${request.auth!.userId}`]);
    const proposal = await db.query<{ state: string; voting_opens_at: Date; voting_closes_at: Date }>(
      "SELECT state, voting_opens_at, voting_closes_at FROM ghall_governance_proposals WHERE id = $1 FOR UPDATE", [proposalId],
    );
    const current = proposal.rows[0];
    if (!current) throw new ApiError(404, "ghall_proposal_not_found", "Governance proposal not found.");
    if (current.state !== "open" || current.voting_opens_at > new Date() || current.voting_closes_at <= new Date()) {
      throw new ApiError(409, "ghall_voting_closed", "This proposal is not accepting votes.");
    }
    const account = await db.query<{ stake_wallet_public_key: string; stake_atomic: string }>(
      "SELECT stake_wallet_public_key, stake_atomic::text FROM ghall_stake_accounts WHERE user_id = $1 AND mint = $2 FOR UPDATE",
      [request.auth!.userId, config.GHALL_MINT ?? ""],
    );
    if (!account.rows[0]) throw new ApiError(403, "ghall_stake_required", "Active GHALL stake is required to vote.");
    const stakeAta = getAssociatedTokenAddressSync(mintFromConfig(), new PublicKey(account.rows[0].stake_wallet_public_key), false, TOKEN_2022_PROGRAM_ID);
    const tokenAccount = await connection.getAccountInfo(stakeAta, config.SOLANA_COMMITMENT);
    const weight = tokenAccount ? BigInt((await connection.getTokenAccountBalance(stakeAta, config.SOLANA_COMMITMENT)).value.amount) : 0n;
    if (weight <= 0n) throw new ApiError(403, "ghall_stake_required", "Active GHALL stake is required to vote.");
    const pendingWithdrawal = await db.query(
      "SELECT 1 FROM ghall_stake_withdrawals WHERE user_id = $1 AND state IN ('pending', 'submitted', 'outcome_unknown') LIMIT 1", [request.auth!.userId],
    );
    if (pendingWithdrawal.rowCount) throw new ApiError(409, "ghall_withdrawal_pending", "A wallet with a pending withdrawal cannot vote.");
    const priorVote = await db.query(
      "SELECT 1 FROM ghall_governance_votes WHERE proposal_id = $1 AND user_id = $2", [proposalId, request.auth!.userId],
    );
    if (priorVote.rowCount) throw new ApiError(409, "ghall_vote_already_cast", "This wallet has already voted on this proposal.");
    await db.query(
      "INSERT INTO ghall_governance_votes (proposal_id, user_id, vote, weight_atomic) VALUES ($1, $2, $3, $4)",
      [proposalId, request.auth!.userId, vote, weight.toString()],
    );
    await db.query(
      `UPDATE ghall_governance_proposals SET ${vote === "yes" ? "yes_atomic" : "no_atomic"} =
         ${vote === "yes" ? "yes_atomic" : "no_atomic"} + $2::numeric, updated_at = now() WHERE id = $1`,
      [proposalId, weight.toString()],
    );
    await db.query("COMMIT");
    response.status(201).json({ data: { proposalId, vote, weightAtomic: weight.toString() } });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

function mintFromConfig() {
  if (!config.GHALL_MINT) throw new ApiError(503, "ghall_unavailable", "$GHALL is not configured on this cluster.");
  return new PublicKey(config.GHALL_MINT);
}

async function finalizeGhallProposal(proposalId: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ghall-proposal:${proposalId}`]);
    const proposal = await db.query<{
      rule_key: string; proposed_value: number; quorum_atomic: string; yes_atomic: string; no_atomic: string;
      state: string; voting_closes_at: Date;
    }>(
      `SELECT rule_key, proposed_value, quorum_atomic::text, yes_atomic::text, no_atomic::text, state, voting_closes_at
         FROM ghall_governance_proposals WHERE id = $1 FOR UPDATE`, [proposalId],
    );
    const row = proposal.rows[0];
    if (!row) throw new ApiError(404, "ghall_proposal_not_found", "Governance proposal not found.");
    if (row.state !== "open") { await db.query("COMMIT"); return row.state; }
    if (row.voting_closes_at > new Date()) throw new ApiError(409, "ghall_voting_open", "This proposal's voting period has not ended.");
    const passed = BigInt(row.yes_atomic) >= BigInt(row.quorum_atomic) && BigInt(row.yes_atomic) > BigInt(row.no_atomic);
    await db.query("UPDATE ghall_governance_proposals SET state = $2, updated_at = now() WHERE id = $1", [proposalId, passed ? "passed" : "rejected"]);
    if (passed) {
      await db.query(
        `INSERT INTO ghall_governance_settings (rule_key, value, proposal_id) VALUES ($1, $2, $3)
         ON CONFLICT (rule_key) DO UPDATE SET value = EXCLUDED.value, proposal_id = EXCLUDED.proposal_id, updated_at = now()`,
        [row.rule_key, row.proposed_value, proposalId],
      );
    }
    await db.query("COMMIT");
    return passed ? "passed" : "rejected";
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

ghallRouter.post("/proposals/:proposalId/finalize", async (request, response) => {
  const proposalId = z.string().uuid().parse(request.params.proposalId);
  response.json({ data: { proposalId, state: await finalizeGhallProposal(proposalId) } });
});

export async function reconcileGhallProposals(limit = 50) {
  const due = await pool.query<{ id: string }>(
    "SELECT id FROM ghall_governance_proposals WHERE state = 'open' AND voting_closes_at <= now() ORDER BY voting_closes_at LIMIT $1",
    [limit],
  );
  const result = { examined: due.rows.length, passed: 0, rejected: 0, errors: 0 };
  for (const proposal of due.rows) {
    try {
      const state = await finalizeGhallProposal(proposal.id);
      if (state === "passed") result.passed += 1;
      if (state === "rejected") result.rejected += 1;
    } catch { result.errors += 1; }
  }
  return result;
}

export async function reconcileGhallStakeWithdrawals(limit = 25) {
  const due = await pool.query<{
    id: string; user_id: string; signature: string; signed_transaction: Buffer;
    last_valid_block_height: string; attempt_id: string;
  }>(
    `SELECT w.id, w.user_id, a.transaction_signature AS signature, a.signed_transaction,
            a.last_valid_block_height::text, a.id AS attempt_id
       FROM ghall_stake_withdrawals w JOIN LATERAL (
         SELECT id, transaction_signature, signed_transaction, last_valid_block_height, state
           FROM ghall_stake_withdrawal_attempts WHERE withdrawal_id = w.id
          ORDER BY created_at DESC LIMIT 1
       ) a ON true
      WHERE w.state IN ('pending', 'submitted', 'failed', 'outcome_unknown') AND a.state IN ('prepared', 'submitted', 'expired', 'outcome_unknown')
      ORDER BY w.created_at LIMIT $1`, [limit],
  );
  const result = { examined: due.rows.length, confirmed: 0, submitted: 0, expired: 0, outcomeUnknown: 0, errors: 0 };
  for (const row of due.rows) {
    const db = await pool.connect();
    let locked = false;
    try {
      await db.query("SELECT pg_advisory_lock(hashtext($1))", [`ghall-stake:${row.user_id}`]);
      locked = true;
      const status = (await connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).value[0];
      if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("BEGIN");
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'confirmed', updated_at = now() WHERE id = $1", [row.attempt_id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'confirmed', updated_at = now() WHERE id = $1", [row.id]);
        await db.query("UPDATE ghall_stake_accounts SET stake_atomic = 0, updated_at = now() WHERE user_id = $1", [row.user_id]);
        await db.query("COMMIT");
        result.confirmed += 1;
      } else if (status && status.err && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'failed', updated_at = now() WHERE id = $1", [row.attempt_id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'failed', updated_at = now() WHERE id = $1", [row.id]);
      } else if (await connection.getBlockHeight(config.SOLANA_COMMITMENT) <= Number(row.last_valid_block_height)) {
        await connection.sendRawTransaction(row.signed_transaction, { maxRetries: 3, skipPreflight: false });
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'submitted', updated_at = now() WHERE id = $1", [row.attempt_id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'submitted', updated_at = now() WHERE id = $1", [row.id]);
        result.submitted += 1;
      } else {
        await db.query("UPDATE ghall_stake_withdrawal_attempts SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [row.attempt_id]);
        await db.query("UPDATE ghall_stake_withdrawals SET state = 'outcome_unknown', updated_at = now() WHERE id = $1", [row.id]);
        result.outcomeUnknown += 1;
        result.errors += 1;
      }
    } catch {
      await db.query("ROLLBACK").catch(() => undefined);
      result.errors += 1;
    } finally {
      if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1))", [`ghall-stake:${row.user_id}`]).catch(() => undefined);
      db.release();
    }
  }
  return result;
}
