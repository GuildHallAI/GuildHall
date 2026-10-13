import { Router } from "express";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { Pool, PoolClient } from "pg";
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
import { evaluatorHasCapacity } from "../ghall.js";
import { pool } from "../db/index.js";
import { createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { encryptPrivateData } from "../private-data.js";
import { decryptPrivateData } from "../private-data.js";
import { returnBountyEntryBond } from "../bounty-bonds.js";
import { bountyCreateInputSchema, createBountyForWallet } from "../bounty-service.js";

const router = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const evidenceItem = z.object({
  kind: z.enum(["url", "text", "hash"]),
  label: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(4000),
});

function formatBountyAmount(amountAtomic: string) {
  const amount = BigInt(amountAtomic);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function signatureBytes(signature: string) {
  try {
    const bytes = bs58.decode(signature);
    if (bytes.length === 64) return bytes;
  } catch { /* handled below */ }
  throw new ApiError(400, "invalid_signature", "Transaction signature must be a 64-byte base58 signature.");
}

async function bountyById(id: string, db: Pool | PoolClient = pool) {
  const result = await db.query<{
    id: string; title: string; description: string; client_user_id: string; client_wallet: string;
    asset_mint: string; amount_atomic: string; status: string; deadline_at: Date;
    funding_signature: string | null; work_category: string; sla_hours: number | null;
    escrow_address: string; bond_atomic: string; max_entries: number; evaluator_user_id: string;
    evaluated_at: Date | null; winning_entry_id: string | null;
  }>(
    `SELECT c.id, c.title, c.description, c.client_user_id, c.client_wallet, c.asset_mint,
            c.amount_atomic, c.status, c.deadline_at, c.funding_signature, c.work_category, c.sla_hours,
            w.public_key AS escrow_address, b.bond_atomic, b.max_entries, b.evaluator_user_id,
            b.evaluated_at, b.winning_entry_id
       FROM commissions c JOIN bounties b ON b.commission_id = c.id
       JOIN commission_escrow_wallets w ON w.commission_id = c.id WHERE c.id = $1`, [id],
  );
  if (!result.rows[0]) throw new ApiError(404, "bounty_not_found", "Bounty not found.");
  return result.rows[0];
}

router.get("/", async (request, response) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() }).parse(request.query);
  const result = await pool.query(
    `SELECT c.id, c.title, c.description, c.client_wallet, c.asset_mint, c.amount_atomic,
            c.status, c.deadline_at, c.work_category, c.sla_hours, b.bond_atomic, b.max_entries,
            (SELECT count(*)::int FROM bounty_entries e WHERE e.commission_id = c.id AND e.bond_confirmed_at IS NOT NULL) AS entrants
       FROM commissions c JOIN bounties b ON b.commission_id = c.id
      WHERE c.work_type = 'bounty' AND c.status IN ('open', 'funded') AND c.deadline_at > now()
        AND ($1::timestamptz IS NULL OR c.created_at < $1)
      ORDER BY c.created_at DESC LIMIT $2`, [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows });
});

router.post("/", requireAuth, async (request, response) => {
  const input = bountyCreateInputSchema.parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  const created = await createBountyForWallet(request.auth!.userId, request.auth!.walletAddress, input, idempotencyKey);
  response.status(created.idempotentReplay ? 200 : 201).json({
    data: await bountyById(created.commissionId),
    idempotentReplay: created.idempotentReplay,
  });
});

router.get("/:id", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const bounty = await bountyById(id);
  const entries = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM bounty_entries WHERE commission_id = $1 AND bond_confirmed_at IS NOT NULL", [id],
  );
  response.json({ data: { ...bounty, entrants: Number(entries.rows[0].count) } });
});

router.get("/:id/x-post", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const result = await pool.query(
    `SELECT p.kind, p.state, p.blink_url, p.tweet_url, p.failure_code, p.attempted_at, p.published_at
       FROM bounty_x_posts p JOIN bounties b ON b.commission_id = p.commission_id
      WHERE p.commission_id = $1 ORDER BY p.created_at`, [id],
  );
  if (!result.rows.length) throw new ApiError(404, "bounty_x_post_not_found", "This bounty has not been queued for X publication.");
  response.json({ data: result.rows });
});

router.get("/:id/action", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const bounty = await bountyById(id);
  const available = bounty.status === "open" && !bounty.funding_signature && bounty.deadline_at > new Date();
  response.setHeader("cache-control", "no-store");
  response.json({
    type: "action", title: "GuildHall Bounty", icon: `${config.GUILDHALL_ACTIONS_BASE_URL.replace(/\/$/, "")}/assets/banner.webp`,
    description: `Fund “${bounty.title}” for ${formatBountyAmount(bounty.amount_atomic)} ${bounty.asset_mint === config.USDT_MINT ? "USDT" : "USDC"}. ${bounty.description.slice(0, 400)}`,
    label: "Fund bounty", disabled: !available,
    ...(available ? {} : { error: { message: "This bounty is not available for funding." } }),
  });
});

router.post("/:id/action", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const { account } = z.object({ account: z.string().min(32).max(44) }).parse(request.body);
  const bounty = await bountyById(id);
  if (bounty.status !== "open" || bounty.funding_signature || bounty.deadline_at <= new Date()) {
    throw new ApiError(409, "bounty_not_fundable", "This bounty is not awaiting Blink funding.");
  }
  let clientWallet: PublicKey;
  try { clientWallet = new PublicKey(account); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana account is required."); }
  if (clientWallet.toBase58() !== bounty.client_wallet) throw new ApiError(403, "bounty_funding_wallet_mismatch", "Only the bounty creator's wallet can fund this bounty.");
  const mint = new PublicKey(bounty.asset_mint);
  const escrowWallet = new PublicKey(bounty.escrow_address);
  const source = getAssociatedTokenAddressSync(mint, clientWallet);
  const destination = getAssociatedTokenAddressSync(mint, escrowWallet);
  const latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({ feePayer: clientWallet, recentBlockhash: latest.blockhash }).add(
    createAssociatedTokenAccountIdempotentInstruction(clientWallet, source, clientWallet, mint),
    createAssociatedTokenAccountIdempotentInstruction(clientWallet, destination, escrowWallet, mint),
    createTransferCheckedInstruction(source, mint, destination, clientWallet, BigInt(bounty.amount_atomic), 6, [], TOKEN_PROGRAM_ID),
  );
  const base = config.GUILDHALL_ACTIONS_BASE_URL.replace(/\/$/, "");
  response.setHeader("cache-control", "no-store");
  response.json({ transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    message: `Fund GuildHall bounty ${id}`,
    links: { next: { type: "post", href: `${base}/api/actions/bounties/${id}/confirm` } },
  });
});

router.post("/:id/bond-returns", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const bounty = await bountyById(id);
  if (!["complete", "refunded"].includes(bounty.status)) throw new ApiError(409, "bounty_not_final", "Entrant bonds return after the bounty settles or refunds.");
  const entries = await pool.query<{ id: string }>(
    "SELECT id FROM bounty_entries WHERE commission_id = $1 AND bond_returned_at IS NULL ORDER BY created_at", [id],
  );
  const results = [];
  for (const entry of entries.rows) results.push({ entryId: entry.id, ...(await returnBountyEntryBond(entry.id)) });
  const pending = results.some((result) => result.state === "submitted" || result.state === "waiting");
  response.status(pending ? 202 : 200).json({ data: { bountyId: id, entries: results } });
});

router.post("/:id/entries", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const db = await pool.connect();
  let entryId: string;
  let bond: string;
  let wallet: string;
  let bondWalletAddress: string;
  let idempotentReplay = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bounty:${id}`]);
    const bounty = await db.query<{
      client_user_id: string; asset_mint: string; amount_atomic: string; status: string; deadline_at: Date;
      escrow_address: string; bond_atomic: string; max_entries: number; evaluated_at: Date | null; evaluator_user_id: string;
    }>(
      `SELECT c.client_user_id, c.asset_mint, c.amount_atomic, c.status, c.deadline_at,
              w.public_key AS escrow_address, b.bond_atomic, b.max_entries, b.evaluated_at, b.evaluator_user_id
         FROM commissions c JOIN bounties b ON b.commission_id = c.id
         JOIN commission_escrow_wallets w ON w.commission_id = c.id WHERE c.id = $1 FOR UPDATE OF c, b`, [id],
    );
    const row = bounty.rows[0];
    if (!row) throw new ApiError(404, "bounty_not_found", "Bounty not found.");
    if (row.client_user_id === request.auth!.userId) throw new ApiError(409, "bounty_client_entry", "The bounty creator cannot enter their own bounty.");
    if (row.evaluator_user_id === request.auth!.userId) throw new ApiError(409, "bounty_evaluator_entry", "The assigned evaluator cannot enter the bounty they will rank.");
    if (row.status !== "funded" || row.evaluated_at || row.deadline_at <= new Date()) throw new ApiError(409, "bounty_closed", "This bounty is not accepting entries.");
    try { wallet = new PublicKey(request.auth!.walletAddress).toBase58(); }
    catch { throw new ApiError(400, "invalid_wallet", "The entrant wallet is invalid."); }
    const mint = new PublicKey(row.asset_mint);
    const payer = new PublicKey(wallet);
    const source = getAssociatedTokenAddressSync(mint, payer);
    const existing = await db.query<{ id: string; wallet_address: string; bond_wallet_public_key: string;
      bond_signature: string | null; bond_recent_blockhash: string | null; bond_last_valid_block_height: string | null }>(
      `SELECT id, wallet_address, bond_wallet_public_key, bond_signature, bond_recent_blockhash,
              bond_last_valid_block_height::text FROM bounty_entries WHERE commission_id = $1 AND user_id = $2 FOR UPDATE`,
      [id, request.auth!.userId],
    );
    let latest: { blockhash: string; lastValidBlockHeight: number };
    if (existing.rows[0]) {
      idempotentReplay = true;
      const entry = existing.rows[0];
      if (entry.wallet_address !== wallet) throw new ApiError(409, "bounty_entry_wallet_changed", "This entry is linked to a different wallet. Contact support to recover the entry bond.");
      if (entry.bond_signature) {
        await db.query("COMMIT");
        response.status(200).json({ data: { entryId: entry.id, bountyId: id, bondConfirmed: true, bondSignature: entry.bond_signature }, idempotentReplay: true });
        return;
      }
      const height = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
      latest = entry.bond_recent_blockhash && entry.bond_last_valid_block_height
        && height <= Number(entry.bond_last_valid_block_height)
        ? { blockhash: entry.bond_recent_blockhash, lastValidBlockHeight: Number(entry.bond_last_valid_block_height) }
        : await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      if (latest.blockhash !== entry.bond_recent_blockhash) await db.query(
        "UPDATE bounty_entries SET bond_recent_blockhash = $2, bond_last_valid_block_height = $3 WHERE id = $1",
        [entry.id, latest.blockhash, latest.lastValidBlockHeight],
      );
      entryId = entry.id;
      bondWalletAddress = entry.bond_wallet_public_key;
    } else {
      const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM bounty_entries WHERE commission_id = $1", [id]);
      if (count.rows[0].n >= row.max_entries) throw new ApiError(409, "bounty_full", "This bounty has reached its entrant limit.");
      const bondWallet = createEncryptedSolanaWallet();
      latest = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO bounty_entries
           (commission_id, user_id, wallet_address, bond_wallet_public_key, encrypted_secret_key,
            bond_encryption_nonce, bond_encryption_auth_tag, bond_encryption_key_version, cluster, bond_atomic,
            bond_recent_blockhash, bond_last_valid_block_height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [id, request.auth!.userId, wallet, bondWallet.publicKey, bondWallet.encryptedSecretKey,
          bondWallet.encryptionNonce, bondWallet.encryptionAuthTag, bondWallet.encryptionKeyVersion,
          config.SOLANA_CLUSTER, row.bond_atomic, latest.blockhash, latest.lastValidBlockHeight],
      );
      entryId = inserted.rows[0].id;
      bondWalletAddress = bondWallet.publicKey;
    }
    const escrow = new PublicKey(bondWalletAddress);
    const destination = getAssociatedTokenAddressSync(mint, escrow);
    const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(payer, source, payer, mint),
      createAssociatedTokenAccountIdempotentInstruction(payer, destination, escrow, mint),
      createTransferCheckedInstruction(source, mint, destination, payer, BigInt(row.bond_atomic), 6, [], TOKEN_PROGRAM_ID),
    );
    bond = row.bond_atomic;
    await db.query("COMMIT");
    response.status(idempotentReplay ? 200 : 201).json({ data: { entryId, bountyId: id, walletAddress: wallet, bondWallet: bondWalletAddress, bondAtomic: bond,
      assetMint: mint.toBase58(), unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      lastValidBlockHeight: latest.lastValidBlockHeight }, idempotentReplay });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
});

router.post("/:id/entries/:entryId/bond-confirm", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const entryId = z.string().uuid().parse(request.params.entryId);
  const { signature } = z.object({ signature: z.string().min(80).max(100) }).parse(request.body);
  signatureBytes(signature);
  const bounty = await bountyById(id);
  const entry = await pool.query<{ id: string; user_id: string; wallet_address: string; bond_wallet_public_key: string; bond_atomic: string; bond_signature: string | null }>(
    "SELECT id, user_id, wallet_address, bond_wallet_public_key, bond_atomic, bond_signature FROM bounty_entries WHERE id = $1 AND commission_id = $2", [entryId, id],
  );
  if (!entry.rows[0]) throw new ApiError(404, "bounty_entry_not_found", "Bounty entry not found.");
  if (entry.rows[0].user_id !== request.auth!.userId || entry.rows[0].wallet_address !== request.auth!.walletAddress) throw new ApiError(403, "bounty_entry_forbidden", "Only the entrant can confirm its bond.");
  if (entry.rows[0].bond_signature === signature) { response.json({ data: { entryId, bondSignature: signature }, idempotentReplay: true }); return; }
  if (entry.rows[0].bond_signature) throw new ApiError(409, "bounty_bond_already_confirmed", "This bounty entry already has a confirmed bond.");

  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) throw new ApiError(409, "bounty_bond_unconfirmed", "The bond transaction must be confirmed on the configured Solana cluster.");
  const parsed = await connection.getParsedTransaction(signature, { commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT, maxSupportedTransactionVersion: 0 });
  if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "bounty_bond_unavailable", "The confirmed bond transaction details are not available yet.");
  const wallet = entry.rows[0].wallet_address;
  const escrowAta = getAssociatedTokenAddressSync(new PublicKey(bounty.asset_mint), new PublicKey(entry.rows[0].bond_wallet_public_key)).toBase58();
  const tokenIndex = parsed.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === escrowAta);
  const signed = parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer);
  const tokenDelta = (balances: typeof parsed.meta.preTokenBalances, owner: string) =>
    balances?.filter((row) => row.mint === bounty.asset_mint && row.owner === owner)
      .reduce((total, row) => total + BigInt(row.uiTokenAmount.amount), 0n) ?? 0n;
  const escrowDelta = tokenIndex < 0 ? 0n :
    (parsed.meta.postTokenBalances?.filter((row) => row.accountIndex === tokenIndex && row.mint === bounty.asset_mint).reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n) ?? 0n)
      - (parsed.meta.preTokenBalances?.filter((row) => row.accountIndex === tokenIndex && row.mint === bounty.asset_mint).reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n) ?? 0n);
  if (!signed || escrowDelta !== BigInt(entry.rows[0].bond_atomic)) throw new ApiError(422, "bounty_bond_mismatch", "The entrant must sign an exact transfer of the configured bond into the bounty escrow.");
  if (tokenDelta(parsed.meta.preTokenBalances, wallet) - tokenDelta(parsed.meta.postTokenBalances, wallet) !== BigInt(entry.rows[0].bond_atomic)) throw new ApiError(422, "bounty_bond_source_mismatch", "The bond must come from the entrant wallet.");
  const updated = await pool.query(
    `UPDATE bounty_entries SET bond_signature = $3, bond_confirmed_at = now()
      WHERE id = $1 AND commission_id = $2 AND bond_signature IS NULL RETURNING id`, [entryId, id, signature],
  );
  if (!updated.rowCount) throw new ApiError(409, "bounty_bond_race", "The bounty entry changed while the bond was being confirmed.");
  response.json({ data: { entryId, bondSignature: signature, confirmed: true } });
});

router.post("/:id/entries/:entryId/submissions", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const entryId = z.string().uuid().parse(request.params.entryId);
  const input = z.object({ summary: z.string().trim().min(1).max(5000), evidence: z.array(evidenceItem).min(1).max(30) }).parse(request.body);
  const bounty = await bountyById(id);
  if (bounty.status !== "funded" || bounty.deadline_at <= new Date() || bounty.evaluated_at) throw new ApiError(409, "bounty_closed", "This bounty is no longer accepting submissions.");
  const entry = await pool.query<{ user_id: string; bond_confirmed_at: Date | null; submitted_at: Date | null }>(
    "SELECT user_id, bond_confirmed_at, submitted_at FROM bounty_entries WHERE id = $1 AND commission_id = $2", [entryId, id],
  );
  if (!entry.rows[0]) throw new ApiError(404, "bounty_entry_not_found", "Bounty entry not found.");
  if (entry.rows[0].user_id !== request.auth!.userId) throw new ApiError(403, "bounty_entry_forbidden", "Only the entrant can submit its work.");
  if (!entry.rows[0].bond_confirmed_at) throw new ApiError(409, "bounty_bond_required", "Confirm the entry bond before submitting work.");
  if (entry.rows[0].submitted_at) throw new ApiError(409, "bounty_submission_exists", "This bounty entry already has a submission.");
  const encrypted = encryptPrivateData(input);
  const updated = await pool.query(
    `UPDATE bounty_entries SET encrypted_payload = $3, encryption_nonce = $4, encryption_auth_tag = $5,
       encryption_key_version = $6, submitted_at = now()
      WHERE id = $1 AND commission_id = $2 AND submitted_at IS NULL RETURNING id, submitted_at`,
    [entryId, id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
  );
  response.status(201).json({ data: updated.rows[0] });
});

router.get("/:id/entries", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const bounty = await bountyById(id);
  if (request.auth!.userId !== bounty.client_user_id && request.auth!.userId !== bounty.evaluator_user_id) {
    const own = await pool.query("SELECT 1 FROM bounty_entries WHERE commission_id = $1 AND user_id = $2", [id, request.auth!.userId]);
    if (!own.rowCount) throw new ApiError(403, "bounty_entries_forbidden", "Only bounty participants can access entries.");
  }
  const rows = await pool.query<{
    id: string; user_id: string; wallet_address: string; bond_atomic: string; bond_confirmed_at: Date | null;
    submitted_at: Date | null; encrypted_payload: Buffer | null; encryption_nonce: Buffer | null;
    encryption_auth_tag: Buffer | null; encryption_key_version: number | null; rank: number | null; rationale: string | null;
  }>(
    `SELECT e.id, e.user_id, e.wallet_address, e.bond_atomic, e.bond_confirmed_at, e.submitted_at,
            e.encrypted_payload, e.encryption_nonce, e.encryption_auth_tag, e.encryption_key_version,
            r.rank, r.rationale
       FROM bounty_entries e LEFT JOIN bounty_rankings r ON r.entry_id = e.id
      WHERE e.commission_id = $1 ORDER BY r.rank NULLS LAST, e.created_at`, [id],
  );
  const evaluator = request.auth!.userId === bounty.evaluator_user_id;
  response.json({ data: rows.rows.map((row) => {
    const { encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version, ...publicRow } = row;
    return { ...publicRow, submission: evaluator && encrypted_payload && encryption_nonce && encryption_auth_tag && encryption_key_version
      ? decryptEntry({ encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version }) : undefined };
  }) });
});

router.post("/:id/evaluate", requireAuth, async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = z.object({
    rankings: z.array(z.object({ entryId: z.string().uuid(), rationale: z.string().trim().min(1).max(1000) })).min(1).max(100),
  }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bounty:${id}`]);
    const bounty = await client.query<{
      evaluator_user_id: string; evaluated_at: Date | null; max_entries: number; commission_status: string;
      deadline_at: Date; amount_atomic: string; provider_user_id: string | null;
    }>(
      `SELECT b.evaluator_user_id, b.evaluated_at, b.max_entries, c.status AS commission_status,
              c.deadline_at, c.amount_atomic, c.provider_user_id
         FROM bounties b JOIN commissions c ON c.id = b.commission_id WHERE b.commission_id = $1 FOR UPDATE OF b, c`, [id],
    );
    const row = bounty.rows[0];
    if (!row) throw new ApiError(404, "bounty_not_found", "Bounty not found.");
    if (row.evaluator_user_id !== request.auth!.userId) throw new ApiError(403, "bounty_evaluator_required", "Only the assigned evaluator can rank this bounty.");
    if (row.evaluated_at || row.commission_status !== "funded") throw new ApiError(409, "bounty_already_evaluated", "This bounty has already been evaluated or is not funded.");
    const evaluator = await client.query<{ active: boolean; stake_atomic: string; wallet_address: string }>(
      `SELECT e.active, e.stake_atomic::text, u.wallet_address FROM evaluator_profiles e
       JOIN wallet_users u ON u.id = e.user_id WHERE e.user_id = $1 FOR UPDATE OF e`, [request.auth!.userId],
    );
    if (!evaluator.rows[0]?.active || !await evaluatorHasCapacity(evaluator.rows[0].wallet_address, evaluator.rows[0].stake_atomic, row.amount_atomic)) {
      throw new ApiError(409, "bounty_evaluator_stake_insufficient", "The assigned evaluator no longer meets the required stake capacity.");
    }
    const entries = await client.query<{ id: string; user_id: string; encrypted_payload: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer; encryption_key_version: number }>(
      `SELECT id, user_id, encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version
         FROM bounty_entries WHERE commission_id = $1 AND bond_confirmed_at IS NOT NULL AND submitted_at IS NOT NULL
         ORDER BY created_at FOR UPDATE`, [id],
    );
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM bounty_entries WHERE commission_id = $1", [id]);
    if (new Date() < row.deadline_at && count.rows[0].n < row.max_entries) throw new ApiError(409, "bounty_ranking_early", "Ranking is available after the entry deadline or when all entrant slots have been used.");
    const pendingEntries = await client.query<{ bond_last_valid_block_height: string }>(
      `SELECT bond_last_valid_block_height::text FROM bounty_entries
        WHERE commission_id = $1 AND bond_signature IS NULL`, [id],
    );
    if (pendingEntries.rows.length) {
      const currentHeight = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
      if (pendingEntries.rows.some((entry) => currentHeight <= Number(entry.bond_last_valid_block_height))) {
        throw new ApiError(409, "bounty_bond_transactions_pending", "Wait for every entrant bond transaction to confirm or expire before ranking.");
      }
    }
    if (new Date() < row.deadline_at) {
      const unsubmitted = await client.query(
        `SELECT 1 FROM bounty_entries WHERE commission_id = $1
          AND bond_confirmed_at IS NOT NULL AND submitted_at IS NULL LIMIT 1`, [id],
      );
      if (unsubmitted.rowCount) throw new ApiError(409, "bounty_submissions_pending", "Wait for every bonded entrant to submit or for the entry deadline to pass.");
    }
    const ids = new Set(entries.rows.map((entry) => entry.id));
    if (entries.rows.length !== input.rankings.length || input.rankings.some((ranking) => !ids.has(ranking.entryId))
      || new Set(input.rankings.map((ranking) => ranking.entryId)).size !== input.rankings.length) {
      throw new ApiError(400, "bounty_rankings_incomplete", "Rank every submitted, bonded entry exactly once.");
    }
    const ordered = input.rankings.map((ranking, index) => ({ ...ranking, rank: index + 1 }));
    for (const ranking of ordered) await client.query(
      `INSERT INTO bounty_rankings (commission_id, entry_id, evaluator_user_id, rank, rationale)
       VALUES ($1, $2, $3, $4, $5)`, [id, ranking.entryId, request.auth!.userId, ranking.rank, ranking.rationale],
    );
    const winner = entries.rows.find((entry) => entry.id === ordered[0].entryId)!;
    const winningPayload = {
      ...winner,
      ...decryptEntry({ encrypted_payload: winner.encrypted_payload, encryption_nonce: winner.encryption_nonce,
        encryption_auth_tag: winner.encryption_auth_tag, encryption_key_version: winner.encryption_key_version }),
    };
    const encrypted = encryptPrivateData({ summary: winningPayload.summary, evidence: winningPayload.evidence });
    await client.query(
      `INSERT INTO commission_submissions
         (commission_id, provider_user_id, revision, encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version)
       VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [id, winner.user_id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
    );
    await client.query(
      `UPDATE commissions SET provider_user_id = $2,
         provider_wallet = (SELECT wallet_address FROM bounty_entries WHERE id = $3),
         accepted_at = now(), status = 'submitted', updated_at = now() WHERE id = $1`, [id, winner.user_id, winner.id],
    );
    await client.query(
      `UPDATE bounties SET evaluated_at = now(), winning_entry_id = $2, evaluation_rationale = $3 WHERE commission_id = $1`,
      [id, winner.id, ordered[0].rationale],
    );
    await client.query("UPDATE bounty_evaluator_assignments SET released_at = now() WHERE commission_id = $1 AND user_id = $2 AND released_at IS NULL", [id, request.auth!.userId]);
    await client.query("COMMIT");
    response.status(201).json({ data: { bountyId: id, winnerEntryId: winner.id, winnerUserId: winner.user_id, rankings: ordered } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

function decryptEntry(row: { encrypted_payload: Buffer; encryption_nonce: Buffer; encryption_auth_tag: Buffer; encryption_key_version: number }) {
  // Local import-free decryption keeps each entry payload inside the evaluator-gated route.
  return decryptPrivateData<{ summary: string; evidence: z.infer<typeof evidenceItem>[] }>({
    ciphertext: row.encrypted_payload, nonce: row.encryption_nonce,
    authTag: row.encryption_auth_tag, keyVersion: row.encryption_key_version,
  });
}

export { router as bountiesRouter };
