import { Router } from "express";
import { createHash } from "node:crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
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
import { createCommissionEscrowWallet, createEncryptedSolanaWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { encryptPrivateData, decryptPrivateData } from "../private-data.js";
import { assertSafeTaskText, taskSafetyAttestation } from "../task-policy.js";
import { submitGuildBondReturn } from "../guild-bond-returns.js";

const router = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const uuid = z.string().uuid();
const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const taskInput = z.object({ walletAddress: z.string().min(32).max(44), title: z.string().trim().min(3).max(160), description: z.string().trim().min(1).max(5000) });

function atomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (result <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return result.toString();
}

function usdcMint() {
  if (!config.USDC_MINT) throw new ApiError(503, "asset_unavailable", "USDC is not configured for this cluster.");
  try { return new PublicKey(config.USDC_MINT).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", "USDC_MINT is not a valid Solana mint address."); }
}

async function guildData(guildId: string) {
  const guild = await pool.query<{
    id: string; owner_user_id: string; name: string; description: string; sla_hours: number;
    bond_target_atomic: string; bond_wallet_public_key: string; bond_mint: string; status: string; created_at: Date;
  }>("SELECT id, owner_user_id, name, description, sla_hours, bond_target_atomic, bond_wallet_public_key, bond_mint, status, created_at FROM guilds WHERE id = $1", [guildId]);
  if (!guild.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
  const [members, bond] = await Promise.all([
    pool.query(`SELECT u.id AS user_id, u.wallet_address, m.role, m.share_bps, m.joined_at
                  FROM guild_members m JOIN wallet_users u ON u.id = m.user_id
                 WHERE m.guild_id = $1 ORDER BY CASE WHEN m.role = 'lead' THEN 0 ELSE 1 END, m.joined_at`, [guildId]),
    pool.query<{ total: string }>("SELECT COALESCE(sum(amount_atomic), 0)::text AS total FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NOT NULL", [guildId]),
  ]);
  const total = bond.rows[0].total;
  return { ...guild.rows[0], bond_confirmed_atomic: total, bond_funded: BigInt(total) >= BigInt(guild.rows[0].bond_target_atomic), members: members.rows };
}

router.post("/", requireAuth, async (request, response) => {
  const input = z.object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().min(1).max(3000),
    slaHours: z.number().int().min(1).max(8760),
    bondTarget: amountInput,
  }).parse(request.body);
  const bondTarget = atomic(input.bondTarget);
  const mint = usdcMint();
  const wallet = createEncryptedSolanaWallet();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const guild = await client.query<{ id: string }>(
      `INSERT INTO guilds (owner_user_id, name, description, sla_hours, bond_target_atomic,
         bond_wallet_public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag,
         encryption_key_version, cluster, bond_mint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [request.auth!.userId, input.name, input.description, input.slaHours, bondTarget, wallet.publicKey,
        wallet.encryptedSecretKey, wallet.encryptionNonce, wallet.encryptionAuthTag,
        wallet.encryptionKeyVersion, config.SOLANA_CLUSTER, mint],
    );
    await client.query("INSERT INTO guild_members (guild_id, user_id, role, share_bps) VALUES ($1, $2, 'lead', 10000)", [guild.rows[0].id, request.auth!.userId]);
    await client.query("COMMIT");
    response.status(201).json({ data: await guildData(guild.rows[0].id) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.get("/mine", requireAuth, async (request, response) => {
  const result = await pool.query<{ id: string }>(
    `SELECT g.id FROM guild_members m JOIN guilds g ON g.id = m.guild_id
      WHERE m.user_id = $1 ORDER BY g.created_at DESC`, [request.auth!.userId],
  );
  const data = [];
  for (const guild of result.rows) data.push(await guildData(guild.id));
  response.json({ data });
});

router.get("/invitations", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT i.id, i.guild_id, g.name AS guild_name, g.sla_hours, i.created_at
       FROM guild_invitations i JOIN guilds g ON g.id = i.guild_id
      WHERE i.invited_user_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`, [request.auth!.userId],
  );
  response.json({ data: result.rows });
});

router.get("/:guildId", async (request, response) => {
  response.json({ data: await guildData(uuid.parse(request.params.guildId)) });
});

router.post("/:guildId/invitations", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const { walletAddress } = z.object({ walletAddress: z.string().min(32).max(44) }).parse(request.body);
  let wallet: string;
  try { wallet = new PublicKey(walletAddress).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const guild = await pool.query("SELECT owner_user_id FROM guilds WHERE id = $1", [guildId]);
  if (!guild.rowCount) throw new ApiError(404, "guild_not_found", "Guild not found.");
  if (guild.rows[0].owner_user_id !== request.auth!.userId) throw new ApiError(403, "guild_lead_required", "Only the Guild lead can invite members.");
  const user = await pool.query<{ id: string }>("SELECT id FROM wallet_users WHERE wallet_address = $1", [wallet]);
  if (!user.rows[0]) throw new ApiError(404, "wallet_not_registered", "The invited wallet must sign in to GuildHall before joining a Guild.");
  if (user.rows[0].id === request.auth!.userId) throw new ApiError(409, "guild_self_invite", "The Guild lead is already a member.");
  const member = await pool.query("SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2", [guildId, user.rows[0].id]);
  if (member.rowCount) throw new ApiError(409, "guild_member_exists", "This wallet is already a Guild member.");
  const result = await pool.query<{ id: string }>(
    `INSERT INTO guild_invitations (guild_id, invited_user_id) VALUES ($1, $2)
     ON CONFLICT (guild_id, invited_user_id) DO UPDATE SET status = 'pending', created_at = now(), accepted_at = NULL
     WHERE guild_invitations.status = 'revoked' RETURNING id`, [guildId, user.rows[0].id],
  );
  if (!result.rows[0]) throw new ApiError(409, "guild_invitation_exists", "A pending or accepted invitation already exists.");
  response.status(201).json({ data: result.rows[0] });
});

router.post("/:guildId/invitations/:invitationId/accept", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const invitationId = uuid.parse(request.params.invitationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invitation = await client.query<{ invited_user_id: string; status: string }>("SELECT invited_user_id, status FROM guild_invitations WHERE id = $1 AND guild_id = $2 FOR UPDATE", [invitationId, guildId]);
    if (!invitation.rows[0]) throw new ApiError(404, "guild_invitation_not_found", "Guild invitation not found.");
    if (invitation.rows[0].invited_user_id !== request.auth!.userId) throw new ApiError(403, "guild_invitation_forbidden", "This invitation belongs to another wallet.");
    if (invitation.rows[0].status !== "pending") throw new ApiError(409, "guild_invitation_closed", "This invitation is no longer pending.");
    await client.query("INSERT INTO guild_members (guild_id, user_id, role, share_bps) VALUES ($1, $2, 'member', 0) ON CONFLICT DO NOTHING", [guildId, request.auth!.userId]);
    await client.query("UPDATE guild_invitations SET status = 'accepted', accepted_at = now() WHERE id = $1", [invitationId]);
    await client.query("COMMIT");
    response.json({ data: { guildId, invitationId, joined: true } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.put("/:guildId/shares", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const input = z.object({ shares: z.array(z.object({ walletAddress: z.string().min(32).max(44), shareBps: z.number().int().min(1).max(10000) })).min(1).max(20) }).parse(request.body);
  if (input.shares.reduce((sum, item) => sum + item.shareBps, 0) !== 10000) throw new ApiError(400, "guild_shares_invalid", "Guild member shares must add up to 10,000 basis points.");
  const wallets = input.shares.map((item) => {
    try { return new PublicKey(item.walletAddress).toBase58(); }
    catch { throw new ApiError(400, "invalid_wallet", "Every Guild member wallet must be a valid Solana address."); }
  });
  if (new Set(wallets).size !== wallets.length) throw new ApiError(400, "guild_shares_duplicate", "Each Guild member can appear only once.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const guild = await client.query<{ owner_user_id: string }>("SELECT owner_user_id FROM guilds WHERE id = $1 FOR UPDATE", [guildId]);
    if (!guild.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
    if (guild.rows[0].owner_user_id !== request.auth!.userId) throw new ApiError(403, "guild_lead_required", "Only the Guild lead can update payout shares.");
    const members = await client.query<{ user_id: string; wallet_address: string }>(
      `SELECT m.user_id, u.wallet_address FROM guild_members m JOIN wallet_users u ON u.id = m.user_id
        WHERE m.guild_id = $1 AND u.wallet_address = ANY($2::text[])`, [guildId, wallets],
    );
    if (members.rows.length !== wallets.length) throw new ApiError(400, "guild_share_nonmember", "Shares can only be assigned to current Guild members.");
    const all = await client.query<{ user_id: string; wallet_address: string }>(
      "SELECT m.user_id, u.wallet_address FROM guild_members m JOIN wallet_users u ON u.id = m.user_id WHERE m.guild_id = $1", [guildId],
    );
    if (all.rows.length !== wallets.length || all.rows.some((member) => !wallets.includes(member.wallet_address))) throw new ApiError(400, "guild_share_roster_mismatch", "Set a payout share for every current Guild member.");
    for (let index = 0; index < input.shares.length; index += 1) {
      const user = members.rows.find((member) => member.wallet_address === wallets[index])!;
      await client.query("UPDATE guild_members SET share_bps = $3 WHERE guild_id = $1 AND user_id = $2", [guildId, user.user_id, input.shares[index]!.shareBps]);
    }
    await client.query("COMMIT");
    response.json({ data: { guildId, shares: input.shares.map((share, index) => ({ walletAddress: wallets[index], shareBps: share.shareBps })) } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.post("/:guildId/bond-instructions", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`guild-bond:${guildId}`]);
    const guild = await client.query<{ bond_target_atomic: string; bond_wallet_public_key: string; bond_mint: string; owner_user_id: string; status: string }>(
      "SELECT bond_target_atomic, bond_wallet_public_key, bond_mint, owner_user_id, status FROM guilds WHERE id = $1 FOR UPDATE", [guildId],
    );
    if (!guild.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
    if (guild.rows[0].status === "closed") throw new ApiError(409, "guild_closed", "A closed Guild cannot receive bond deposits.");
    const membership = await client.query("SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2", [guildId, request.auth!.userId]);
    if (!membership.rowCount) throw new ApiError(403, "guild_member_required", "Only Guild members can fund the shared bond.");
    const sums = await client.query<{ confirmed: string }>(
      "SELECT COALESCE(sum(amount_atomic), 0)::text AS confirmed FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NOT NULL", [guildId],
    );
    const pending = await client.query<{ id: string; depositor_user_id: string; depositor_wallet: string; amount_atomic: string; recent_blockhash: string; last_valid_block_height: string }>(
      "SELECT id, depositor_user_id, depositor_wallet, amount_atomic, recent_blockhash, last_valid_block_height::text FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NULL FOR UPDATE", [guildId],
    );
    let amount: string;
    let depositId: string;
    let recent: { blockhash: string; lastValidBlockHeight: number };
    if (pending.rows[0]) {
      const row = pending.rows[0];
      if (row.depositor_user_id !== request.auth!.userId || row.depositor_wallet !== request.auth!.walletAddress) throw new ApiError(409, "guild_bond_payment_pending", "Another Guild member already has a bond deposit awaiting confirmation.");
      const height = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
      if (height > Number(row.last_valid_block_height)) {
        const mint = new PublicKey(guild.rows[0].bond_mint);
        const vault = new PublicKey(guild.rows[0].bond_wallet_public_key);
        const ata = getAssociatedTokenAddressSync(mint, vault);
        const actual = await connection.getAccountInfo(ata, config.SOLANA_COMMITMENT)
          ? BigInt((await connection.getTokenAccountBalance(ata, config.SOLANA_COMMITMENT)).value.amount) : 0n;
        if (actual >= BigInt(sums.rows[0].confirmed) + BigInt(row.amount_atomic)) {
          throw new ApiError(409, "guild_bond_deposit_needs_confirmation", `A prior deposit may already have landed. Confirm its signature with depositId ${row.id} before requesting a new transaction.`);
        }
        recent = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
        await client.query("UPDATE guild_bond_deposits SET recent_blockhash = $2, last_valid_block_height = $3 WHERE id = $1", [row.id, recent.blockhash, recent.lastValidBlockHeight]);
      } else recent = { blockhash: row.recent_blockhash, lastValidBlockHeight: Number(row.last_valid_block_height) };
      amount = row.amount_atomic;
      depositId = row.id;
    } else {
      if (BigInt(sums.rows[0].confirmed) >= BigInt(guild.rows[0].bond_target_atomic)) throw new ApiError(409, "guild_bond_funded", "The Guild shared bond is fully funded.");
      amount = (BigInt(guild.rows[0].bond_target_atomic) - BigInt(sums.rows[0].confirmed)).toString();
      recent = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO guild_bond_deposits (guild_id, depositor_user_id, depositor_wallet, amount_atomic, recent_blockhash, last_valid_block_height)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [guildId, request.auth!.userId, request.auth!.walletAddress, amount, recent.blockhash, recent.lastValidBlockHeight],
      );
      depositId = inserted.rows[0].id;
    }
    const mint = new PublicKey(guild.rows[0].bond_mint);
    const payer = new PublicKey(request.auth!.walletAddress);
    const vault = new PublicKey(guild.rows[0].bond_wallet_public_key);
    const source = getAssociatedTokenAddressSync(mint, payer);
    const target = getAssociatedTokenAddressSync(mint, vault);
    const transaction = new Transaction({ feePayer: payer, recentBlockhash: recent.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(payer, source, payer, mint),
      createAssociatedTokenAccountIdempotentInstruction(payer, target, vault, mint),
      createTransferCheckedInstruction(source, mint, target, payer, BigInt(amount), 6, [], TOKEN_PROGRAM_ID),
    );
    await client.query("COMMIT");
    response.json({ data: { guildId, depositId, amountAtomic: amount, assetMint: mint.toBase58(),
      unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      lastValidBlockHeight: recent.lastValidBlockHeight } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.post("/:guildId/bond-confirm", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const input = z.object({ depositId: uuid, signature: z.string().min(80).max(100) }).parse(request.body);
  let bytes: Uint8Array;
  try { bytes = bs58.decode(input.signature); } catch { throw new ApiError(400, "invalid_signature", "Transaction signature must be base58 encoded."); }
  if (bytes.length !== 64) throw new ApiError(400, "invalid_signature", "Transaction signature has an invalid length.");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`guild-bond:${guildId}`]);
    const data = await db.query<{ owner_user_id: string; bond_wallet_public_key: string; bond_mint: string; bond_target_atomic: string }>(
      "SELECT owner_user_id, bond_wallet_public_key, bond_mint, bond_target_atomic FROM guilds WHERE id = $1 FOR UPDATE", [guildId],
    );
    if (!data.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
    const deposit = await db.query<{ depositor_user_id: string; depositor_wallet: string; amount_atomic: string; transaction_signature: string | null }>(
      "SELECT depositor_user_id, depositor_wallet, amount_atomic, transaction_signature FROM guild_bond_deposits WHERE id = $1 AND guild_id = $2 FOR UPDATE", [input.depositId, guildId],
    );
    const row = deposit.rows[0];
    if (!row) throw new ApiError(404, "guild_bond_deposit_not_found", "Guild bond deposit not found.");
    if (row.depositor_user_id !== request.auth!.userId || row.depositor_wallet !== request.auth!.walletAddress) throw new ApiError(403, "guild_bond_deposit_forbidden", "Only the depositing wallet can confirm this Guild bond.");
    if (row.transaction_signature === input.signature) { await db.query("COMMIT"); response.json({ data: { guildId, depositId: input.depositId, confirmed: true }, idempotentReplay: true }); return; }
    if (row.transaction_signature) throw new ApiError(409, "guild_bond_already_confirmed", "This Guild bond deposit is already confirmed.");
    const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
    if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) throw new ApiError(409, "guild_bond_unconfirmed", "The bond transaction must be confirmed on the selected Solana cluster.");
    const parsed = await connection.getParsedTransaction(input.signature, { commitment: config.SOLANA_COMMITMENT === "processed" ? "confirmed" : config.SOLANA_COMMITMENT, maxSupportedTransactionVersion: 0 });
    if (!parsed?.meta || parsed.meta.err) throw new ApiError(409, "guild_bond_unavailable", "Confirmed Guild bond transaction details are not available yet.");
    const mint = new PublicKey(data.rows[0].bond_mint);
    const vaultAta = getAssociatedTokenAddressSync(mint, new PublicKey(data.rows[0].bond_wallet_public_key)).toBase58();
    const index = parsed.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === vaultAta);
    const signed = parsed.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === row.depositor_wallet && key.signer);
    const amountAt = (balances: typeof parsed.meta.preTokenBalances, accountIndex: number) => balances?.filter((item) => item.accountIndex === accountIndex && item.mint === mint.toBase58()).reduce((sum, item) => sum + BigInt(item.uiTokenAmount.amount), 0n) ?? 0n;
    const delta = index < 0 ? 0n : amountAt(parsed.meta.postTokenBalances, index) - amountAt(parsed.meta.preTokenBalances, index);
    const walletBalance = (balances: typeof parsed.meta.preTokenBalances) => balances?.filter((item) => item.owner === row.depositor_wallet && item.mint === mint.toBase58()).reduce((sum, item) => sum + BigInt(item.uiTokenAmount.amount), 0n) ?? 0n;
    if (!signed || delta !== BigInt(row.amount_atomic) || walletBalance(parsed.meta.preTokenBalances) - walletBalance(parsed.meta.postTokenBalances) !== BigInt(row.amount_atomic)) {
      throw new ApiError(422, "guild_bond_amount_mismatch", "The depositing Guild member must sign the exact configured USDC bond transfer.");
    }
    await db.query("UPDATE guild_bond_deposits SET transaction_signature = $2, confirmed_at = now() WHERE id = $1", [input.depositId, input.signature]);
    const funded = await db.query<{ total: string }>("SELECT COALESCE(sum(amount_atomic), 0)::text AS total FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NOT NULL", [guildId]);
    const active = BigInt(funded.rows[0].total) >= BigInt(data.rows[0].bond_target_atomic);
    await db.query("UPDATE guilds SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'closed'", [guildId, active ? "active" : "forming"]);
    await db.query("COMMIT");
    response.json({ data: { guildId, depositId: input.depositId, confirmed: true, bondAtomic: funded.rows[0].total, funded: active }, idempotentReplay: false });
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
});

router.post("/:guildId/close", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const client = await pool.connect();
  let returnIds: string[] = [];
  try {
    await client.query("BEGIN");
    const guild = await client.query<{ owner_user_id: string; bond_mint: string; bond_wallet_public_key: string; status: string }>(
      "SELECT owner_user_id, bond_mint, bond_wallet_public_key, status FROM guilds WHERE id = $1 FOR UPDATE", [guildId],
    );
    if (!guild.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
    if (guild.rows[0].owner_user_id !== request.auth!.userId) throw new ApiError(403, "guild_lead_required", "Only the Guild lead can close this Guild.");
    if (guild.rows[0].status === "closed") {
      const prior = await client.query<{ id: string }>("SELECT id FROM guild_bond_returns WHERE guild_id = $1 ORDER BY created_at", [guildId]);
      returnIds = prior.rows.map((row) => row.id);
      await client.query("COMMIT");
    } else {
      const activeWork = await client.query(
        `SELECT 1 FROM guild_commissions gc JOIN commissions c ON c.id = gc.commission_id
          WHERE gc.guild_id = $1 AND c.status NOT IN ('complete', 'refunded') LIMIT 1`, [guildId],
      );
      if (activeWork.rowCount) throw new ApiError(409, "guild_work_open", "The Guild has commissions that have not reached a final settlement.");
      const pending = await client.query<{ id: string; last_valid_block_height: string }>(
        "SELECT id, last_valid_block_height::text FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NULL FOR UPDATE", [guildId],
      );
      if (pending.rows.length) {
        const height = await connection.getBlockHeight(config.SOLANA_COMMITMENT);
        if (pending.rows.some((row) => height <= Number(row.last_valid_block_height))) {
          throw new ApiError(409, "guild_bond_deposit_pending", "A Guild bond transaction is still within its confirmation window.");
        }
        const mint = new PublicKey(guild.rows[0].bond_mint);
        const vault = new PublicKey(guild.rows[0].bond_wallet_public_key);
        const ata = getAssociatedTokenAddressSync(mint, vault);
        const actual = await connection.getAccountInfo(ata, config.SOLANA_COMMITMENT)
          ? BigInt((await connection.getTokenAccountBalance(ata, config.SOLANA_COMMITMENT)).value.amount) : 0n;
        const confirmed = await client.query<{ total: string }>(
          "SELECT COALESCE(sum(amount_atomic), 0)::text AS total FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NOT NULL", [guildId],
        );
        if (actual !== BigInt(confirmed.rows[0].total)) {
          throw new ApiError(409, "guild_bond_deposit_unreconciled", "The Guild vault balance differs from recorded deposits. Confirm or reconcile the pending bond before closing.");
        }
        await client.query("DELETE FROM guild_bond_deposits WHERE id = ANY($1::uuid[])", [pending.rows.map((row) => row.id)]);
      }
      await client.query("UPDATE guilds SET status = 'closed', updated_at = now() WHERE id = $1", [guildId]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO guild_bond_returns (deposit_id, guild_id, amount_atomic)
         SELECT id, guild_id, amount_atomic FROM guild_bond_deposits
          WHERE guild_id = $1 AND confirmed_at IS NOT NULL
         ON CONFLICT (deposit_id) DO UPDATE SET updated_at = guild_bond_returns.updated_at
         RETURNING id`, [guildId],
      );
      returnIds = inserted.rows.map((row) => row.id);
      await client.query("COMMIT");
    }
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }

  const results = [];
  for (const id of returnIds) {
    try { results.push({ id, ...(await submitGuildBondReturn(id)) }); }
    catch (error) { results.push({ id, state: "pending", error: error instanceof ApiError ? error.code : "guild_bond_return_error" }); }
  }
  response.json({ data: { guildId, status: "closed", bondReturns: results } });
});

router.post("/:guildId/commissions", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const input = z.object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(20_000),
    asset: z.enum(["USDC", "USDT"]),
    amount: amountInput,
    category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    tasks: z.array(taskInput).min(1).max(100),
    safetyAttestation: taskSafetyAttestation,
  }).parse(request.body);
  assertSafeTaskText(input.title, input.description);
  for (const task of input.tasks) assertSafeTaskText(task.title, task.description);
  const taskWallets = input.tasks.map((task) => {
    try { return new PublicKey(task.walletAddress).toBase58(); }
    catch { throw new ApiError(400, "invalid_wallet", "Every Guild task assignee must be a valid Solana wallet."); }
  });
  const amountAtomic = atomic(input.amount);
  const mint = input.asset === "USDC" ? usdcMint() : (() => {
    if (!config.USDT_MINT) throw new ApiError(503, "asset_unavailable", "USDT is not configured for this cluster.");
    try { return new PublicKey(config.USDT_MINT).toBase58(); }
    catch { throw new ApiError(503, "asset_misconfigured", "USDT_MINT is not a valid Solana mint address."); }
  })();
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  const requestHash = createHash("sha256").update(JSON.stringify({ guildId, ...input, taskWallets, mint, amountAtomic })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`guild:${guildId}`, idempotencyKey]);
    const guild = await client.query<{ owner_user_id: string; sla_hours: number; bond_target_atomic: string; bond_wallet_public_key: string; bond_mint: string; status: string; wallet_address: string }>(
      `SELECT g.owner_user_id, g.sla_hours, g.bond_target_atomic, g.bond_wallet_public_key, g.bond_mint, g.status, u.wallet_address
         FROM guilds g JOIN wallet_users u ON u.id = g.owner_user_id WHERE g.id = $1 FOR UPDATE OF g`, [guildId],
    );
    if (!guild.rows[0]) throw new ApiError(404, "guild_not_found", "Guild not found.");
    if (guild.rows[0].owner_user_id === request.auth!.userId) throw new ApiError(409, "guild_cannot_self_fund", "The Guild lead cannot fund work for their own Guild.");
    const clientMember = await client.query("SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2", [guildId, request.auth!.userId]);
    if (clientMember.rowCount) throw new ApiError(409, "guild_client_member", "A Guild member cannot fund a commission for their own Guild.");
    const bond = await client.query<{ total: string }>("SELECT COALESCE(sum(amount_atomic), 0)::text AS total FROM guild_bond_deposits WHERE guild_id = $1 AND confirmed_at IS NOT NULL", [guildId]);
    if (BigInt(bond.rows[0].total) < BigInt(guild.rows[0].bond_target_atomic) || guild.rows[0].status !== "active") throw new ApiError(409, "guild_bond_not_funded", "The Guild must fully fund its shared USDC bond before taking commissions.");
    const shares = await client.query<{ user_id: string; wallet_address: string; share_bps: number }>(
      `SELECT m.user_id, u.wallet_address, m.share_bps FROM guild_members m
         JOIN wallet_users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.share_bps > 0 ORDER BY m.joined_at`, [guildId],
    );
    if (!shares.rows.length || shares.rows.reduce((sum, row) => sum + row.share_bps, 0) !== 10000) throw new ApiError(409, "guild_shares_unconfigured", "Set a complete 100 percent share plan for every Guild member before posting work.");
    if (shares.rows.some((row) => row.user_id === request.auth!.userId)) throw new ApiError(409, "guild_client_contributor", "The client cannot receive a payout from its own commission.");
    const shareMap = new Map(shares.rows.map((row) => [row.wallet_address, row.user_id]));
    if (taskWallets.some((wallet) => !shareMap.has(wallet)) || new Set(taskWallets).size !== taskWallets.length) throw new ApiError(400, "guild_task_assignee_invalid", "Assign one task to each paid Guild member, and use a unique assignee wallet.");
    if (shares.rows.some((row) => !taskWallets.includes(row.wallet_address))) throw new ApiError(400, "guild_task_missing", "Every paid Guild member must receive a task for the commission.");
    const smallestShare = Math.min(...shares.rows.map((row) => row.share_bps));
    const workerNet = BigInt(amountAtomic) - BigInt(amountAtomic) * 200n / 10000n;
    if (workerNet * BigInt(smallestShare) / 10000n < 1n || (workerNet / 2n) * BigInt(smallestShare) / 10000n < 1n) throw new ApiError(400, "guild_amount_too_small", "The commission amount must support every Guild member's share after fees and a possible split.");
    const scopedKey = `guild:${guildId}:${idempotencyKey}`;
    const existing = await client.query<{ id: string; request_hash: string | null }>("SELECT id, request_hash FROM commissions WHERE client_user_id = $1 AND idempotency_key = $2", [request.auth!.userId, scopedKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different Guild work.");
      await client.query("COMMIT");
      response.status(200).json({ data: { commissionId: existing.rows[0].id, idempotentReplay: true } });
      return;
    }
    const deadline = new Date(Date.now() + guild.rows[0].sla_hours * 60 * 60 * 1000);
    const commission = await client.query<{ id: string }>(
      `INSERT INTO commissions
         (client_user_id, client_wallet, provider_user_id, provider_wallet, title, description, asset_mint,
          amount_atomic, status, deadline_at, idempotency_key, request_hash, work_type, work_category, sla_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, 'guild', $12, $13) RETURNING id`,
      [request.auth!.userId, request.auth!.walletAddress, guild.rows[0].owner_user_id, guild.rows[0].wallet_address,
        input.title, input.description, mint, amountAtomic, deadline, scopedKey, requestHash, input.category, guild.rows[0].sla_hours],
    );
    const commissionId = commission.rows[0].id;
    await client.query("INSERT INTO guild_commissions (commission_id, guild_id, lead_user_id, sla_hours) VALUES ($1, $2, $3, $4)", [commissionId, guildId, guild.rows[0].owner_user_id, guild.rows[0].sla_hours]);
    await createCommissionEscrowWallet(client, commissionId);
    for (let index = 0; index < shares.rows.length; index += 1) {
      const share = shares.rows[index]!;
      await client.query("INSERT INTO commission_payout_shares (commission_id, user_id, wallet_address, share_bps, payout_order) VALUES ($1, $2, $3, $4, $5)", [commissionId, share.user_id, share.wallet_address, share.share_bps, index + 1]);
    }
    for (const task of input.tasks) await client.query("INSERT INTO crew_tasks (commission_id, assignee_user_id, title, description) VALUES ($1, $2, $3, $4)", [commissionId, shareMap.get(taskWallets[input.tasks.indexOf(task)]), task.title, task.description]);
    await client.query("COMMIT");
    response.status(201).json({ data: { commissionId, guildId, slaHours: guild.rows[0].sla_hours, deadlineAt: deadline, status: "open", idempotentReplay: false } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.get("/:guildId/commissions/:commissionId/tasks", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const commissionId = uuid.parse(request.params.commissionId);
  const member = await pool.query("SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2", [guildId, request.auth!.userId]);
  if (!member.rowCount) throw new ApiError(403, "guild_member_required", "Only Guild members can read task submissions.");
  const tasks = await pool.query<{
    id: string; assignee_user_id: string; wallet_address: string; title: string; description: string; status: string;
    submitted_at: Date | null; reviewed_at: Date | null; review_rationale: string | null; encrypted_payload: Buffer | null;
    encryption_nonce: Buffer | null; encryption_auth_tag: Buffer | null; encryption_key_version: number | null;
  }>(
    `SELECT t.*, u.wallet_address FROM crew_tasks t JOIN guild_commissions gc ON gc.commission_id = t.commission_id
       JOIN wallet_users u ON u.id = t.assignee_user_id
      WHERE t.commission_id = $1 AND gc.guild_id = $2 ORDER BY t.created_at`, [commissionId, guildId],
  );
  response.json({ data: tasks.rows.map((row) => {
    const { encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version, ...task } = row;
    return { ...task, submission: encrypted_payload && encryption_nonce && encryption_auth_tag && encryption_key_version
      ? decryptPrivateData({ ciphertext: encrypted_payload, nonce: encryption_nonce, authTag: encryption_auth_tag, keyVersion: encryption_key_version }) : null };
  }) });
});

router.post("/:guildId/commissions/:commissionId/tasks/:taskId/submission", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const commissionId = uuid.parse(request.params.commissionId);
  const taskId = uuid.parse(request.params.taskId);
  const input = z.object({ summary: z.string().trim().min(1).max(5000), evidence: z.array(z.object({ kind: z.enum(["url", "text", "hash"]), label: z.string().trim().min(1).max(160), value: z.string().trim().min(1).max(4000) })).min(1).max(30) }).parse(request.body);
  const task = await pool.query<{ assignee_user_id: string; status: string; commission_status: string; accepted_at: Date | null; deadline_at: Date }>(
    `SELECT t.assignee_user_id, t.status, c.status AS commission_status, c.accepted_at, c.deadline_at FROM crew_tasks t
       JOIN guild_commissions gc ON gc.commission_id = t.commission_id JOIN commissions c ON c.id = t.commission_id
      WHERE t.id = $1 AND t.commission_id = $2 AND gc.guild_id = $3`, [taskId, commissionId, guildId],
  );
  if (!task.rows[0]) throw new ApiError(404, "guild_task_not_found", "Guild task not found.");
  if (task.rows[0].assignee_user_id !== request.auth!.userId) throw new ApiError(403, "guild_task_forbidden", "Only the assigned Guild member can submit this task.");
  if (!task.rows[0].accepted_at || !["funded", "submitted"].includes(task.rows[0].commission_status)) throw new ApiError(409, "guild_commission_not_ready", "The lead must accept a funded commission before Guild members deliver tasks.");
  if (task.rows[0].deadline_at <= new Date()) throw new ApiError(409, "guild_commission_expired", "The Guild commission deadline has passed; late task submissions are closed.");
  if (!["assigned", "changes_requested"].includes(task.rows[0].status)) throw new ApiError(409, "guild_task_not_submittable", "This task is already submitted or accepted.");
  const encrypted = encryptPrivateData(input);
  const saved = await pool.query(
    `UPDATE crew_tasks SET status = 'submitted', encrypted_payload = $2, encryption_nonce = $3,
       encryption_auth_tag = $4, encryption_key_version = $5, submitted_at = now(), reviewed_at = NULL,
       review_rationale = NULL, updated_at = now() WHERE id = $1 RETURNING id, status, submitted_at`,
    [taskId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
  );
  response.status(201).json({ data: saved.rows[0] });
});

router.post("/:guildId/commissions/:commissionId/tasks/:taskId/review", requireAuth, async (request, response) => {
  const guildId = uuid.parse(request.params.guildId);
  const commissionId = uuid.parse(request.params.commissionId);
  const taskId = uuid.parse(request.params.taskId);
  const input = z.object({ decision: z.enum(["accept", "request_changes"]), rationale: z.string().trim().min(1).max(5000) }).parse(request.body);
  const lead = await pool.query("SELECT 1 FROM guild_commissions WHERE commission_id = $1 AND guild_id = $2 AND lead_user_id = $3", [commissionId, guildId, request.auth!.userId]);
  if (!lead.rowCount) throw new ApiError(403, "guild_lead_required", "Only the Guild lead can review task delivery.");
  const result = await pool.query(
    `UPDATE crew_tasks SET status = $4, reviewed_at = now(), review_rationale = $5, updated_at = now()
      WHERE id = $1 AND commission_id = $2 AND status = 'submitted'
      AND EXISTS (SELECT 1 FROM guild_commissions WHERE commission_id = $2 AND guild_id = $3) RETURNING id`,
    [taskId, commissionId, guildId, input.decision === "accept" ? "accepted" : "changes_requested", input.rationale],
  );
  if (!result.rowCount) throw new ApiError(409, "guild_task_not_reviewable", "This Guild task has no submission awaiting review.");
  response.json({ data: { taskId, ...input } });
});

export { router as guildsRouter };
