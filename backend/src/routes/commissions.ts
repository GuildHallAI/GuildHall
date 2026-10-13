import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { createCommissionEscrowWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";

const router = Router();
const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, "Use a positive decimal amount with at most 6 decimal places.");
const createInput = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(20_000),
  asset: z.enum(["USDC", "USDT"]),
  amount: amountInput,
  providerWallet: z.string().min(32).max(44).optional(),
  deadlineAt: z.coerce.date().optional(),
});
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
  deadline_at: Date | null;
  accepted_at: Date | null;
  funding_signature: string | null;
  funded_at: Date | null;
  created_at: Date;
  updated_at: Date;
  escrow_address?: string;
};

const publicCommission = (row: CommissionRow) => ({
  id: row.id,
  clientWallet: row.client_wallet,
  providerWallet: row.provider_wallet,
  title: row.title,
  description: row.description,
  assetMint: row.asset_mint,
  amountAtomic: row.amount_atomic,
  status: row.status,
  deadlineAt: row.deadline_at,
  acceptedAt: row.accepted_at,
  fundingSignature: row.funding_signature,
  fundedAt: row.funded_at,
  escrowAddress: row.escrow_address,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function assetMint(asset: "USDC" | "USDT") {
  const mint = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!mint) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try {
    return new PublicKey(mint).toBase58();
  } catch {
    throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid mint configuration.`);
  }
}

function canonicalWallet(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new ApiError(400, "invalid_wallet", "Provider wallet must be a valid Solana address.");
  }
}

function toAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return atomic.toString();
}

async function commissionById(id: string) {
  const result = await pool.query<CommissionRow>(
    `SELECT c.*, w.public_key AS escrow_address
     FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
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
    `SELECT c.*, w.public_key AS escrow_address
     FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
     WHERE c.status = 'open' AND c.accepted_at IS NULL
       AND ($1::timestamptz IS NULL OR c.created_at < $1)
     ORDER BY c.created_at DESC LIMIT $2`,
    [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows.map(publicCommission) });
});

router.post("/", requireAuth, async (request, response) => {
  const input = createInput.parse(request.body);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }
  if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now()) {
    throw new ApiError(400, "invalid_deadline", "The deadline must be in the future.");
  }
  const providerWallet = input.providerWallet ? canonicalWallet(input.providerWallet) : null;
  const mint = assetMint(input.asset);
  const amountAtomic = toAtomic(input.amount);
  const requestHash = createHash("sha256")
    .update(JSON.stringify({
      title: input.title,
      description: input.description,
      asset: input.asset,
      mint,
      amountAtomic,
      providerWallet,
      deadlineAt: input.deadlineAt?.toISOString() ?? null,
    }))
    .digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [request.auth!.userId, idempotencyKey]);
    const existing = await client.query<CommissionRow & { request_hash: string | null }>(
      `SELECT c.*, w.public_key AS escrow_address
       FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
       WHERE c.client_user_id = $1 AND c.idempotency_key = $2`,
      [request.auth!.userId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different commission details.");
      }
      await client.query("COMMIT");
      response.status(200).json({ data: publicCommission(existing.rows[0]), idempotentReplay: true });
      return;
    }
    const inserted = await client.query<CommissionRow>(
      `INSERT INTO commissions
         (client_user_id, client_wallet, provider_wallet, title, description, asset_mint,
          amount_atomic, status, deadline_at, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)
       RETURNING *`,
      [request.auth!.userId, request.auth!.walletAddress, providerWallet, input.title,
        input.description, mint, amountAtomic, input.deadlineAt ?? null, idempotencyKey, requestHash],
    );
    const escrow = await createCommissionEscrowWallet(client, inserted.rows[0].id);
    const commission = { ...inserted.rows[0], escrow_address: escrow.publicKey };
    await client.query("COMMIT");
    response.status(201).json({ data: publicCommission(commission), idempotentReplay: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/:id", async (request, response) => {
  const commission = await commissionById(uuidSchema.parse(request.params.id));
  response.json({ data: publicCommission(commission) });
});

router.get("/:id/funding-instructions", async (request, response) => {
  const commission = await commissionById(uuidSchema.parse(request.params.id));
  if (!commission.escrow_address) throw new ApiError(409, "escrow_unavailable", "The commission escrow account is not ready.");
  if (commission.funding_signature) throw new ApiError(409, "already_funded", "This commission already has a confirmed funding transaction.");
  const escrow = new PublicKey(commission.escrow_address);
  const mint = new PublicKey(commission.asset_mint);
  const client = new PublicKey(commission.client_wallet);
  const sourceTokenAccount = getAssociatedTokenAddressSync(mint, client);
  const tokenAccount = getAssociatedTokenAddressSync(mint, escrow);
  const latestBlockhash = await connection.getLatestBlockhash(config.SOLANA_COMMITMENT);
  const transaction = new Transaction({
    feePayer: client,
    recentBlockhash: latestBlockhash.blockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(client, sourceTokenAccount, client, mint),
    createAssociatedTokenAccountIdempotentInstruction(client, tokenAccount, escrow, mint),
    createTransferCheckedInstruction(
      sourceTokenAccount,
      mint,
      tokenAccount,
      client,
      BigInt(commission.amount_atomic),
      6,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  response.json({
    data: {
      commissionId: commission.id,
      cluster: config.SOLANA_CLUSTER,
      assetMint: commission.asset_mint,
      sourceTokenAccount: sourceTokenAccount.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
      escrowOwner: escrow.toBase58(),
      amountAtomic: commission.amount_atomic,
      decimals: 6,
      clientWallet: commission.client_wallet,
      unsignedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
  });
});

router.post("/:id/accept", requireAuth, async (request, response) => {
  const id = uuidSchema.parse(request.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<CommissionRow & { client_user_id: string; provider_user_id: string | null }>(
      "SELECT * FROM commissions WHERE id = $1 FOR UPDATE", [id],
    );
    const commission = result.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.client_user_id === request.auth!.userId) throw new ApiError(409, "self_acceptance", "A client cannot accept their own commission.");
    if (commission.provider_wallet && commission.provider_user_id !== request.auth!.userId) {
      throw new ApiError(409, "commission_claimed", "This commission has already been accepted by another provider.");
    }
    if (!["open", "funded"].includes(commission.status)) throw new ApiError(409, "commission_unavailable", "This commission cannot be accepted in its current state.");
    if (commission.provider_wallet && commission.provider_wallet !== request.auth!.walletAddress) {
      throw new ApiError(409, "provider_wallet_mismatch", "This commission is assigned to a different provider wallet.");
    }
    const updated = await client.query<CommissionRow>(
      `UPDATE commissions SET provider_user_id = $2, provider_wallet = $3,
         accepted_at = COALESCE(accepted_at, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, request.auth!.userId, request.auth!.walletAddress],
    );
    await client.query("COMMIT");
    response.json({ data: publicCommission(updated.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/:id/funding/confirm", requireAuth, async (request, response) => {
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
  if (initial.client_wallet !== request.auth!.walletAddress) throw new ApiError(403, "commission_forbidden", "Only the commission client can confirm its funding.");
  if (!initial.escrow_address) throw new ApiError(409, "escrow_unavailable", "The commission escrow account is not ready.");
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
    if (commission.funding_signature === signature) {
      await client.query("COMMIT");
      response.json({ data: publicCommission(await commissionById(id)), idempotentReplay: true });
      return;
    }
    if (commission.client_wallet !== request.auth!.walletAddress || commission.status !== "open" || commission.funding_signature) {
      throw new ApiError(409, "commission_not_fundable", "This commission is not awaiting funding.");
    }
    await client.query(
      `INSERT INTO commission_escrow_operations
         (commission_id, idempotency_key, operation, asset_kind, mint, amount_atomic, destination, state, transaction_signature)
       VALUES ($1, $2, 'fund', 'spl', $3, $4, $5, 'confirmed', $2)`,
      [id, `fund:${signature}`, mint.toBase58(), initial.amount_atomic, tokenAccount],
    );
    const updated = await client.query<CommissionRow>(
      `UPDATE commissions SET status = 'funded', funding_signature = $2,
         funded_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, signature],
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

export const commissionsRouter = router;
