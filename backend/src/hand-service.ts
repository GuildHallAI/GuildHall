import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { createCommissionEscrowWallet } from "./escrow-wallets.js";
import { ApiError } from "./http.js";
import { assertSafeTaskText, taskSafetyAttestation } from "./task-policy.js";

const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, "Use a positive decimal amount with at most 6 decimal places.");
const categorySchemas = {
  public_place_photo: ["photo", "timestamp", "location_cell"],
  inventory_count: ["photo", "timestamp", "checklist"],
  accessibility_observation: ["photo", "timestamp", "location_cell", "checklist"],
} as const;
const categories = Object.keys(categorySchemas) as [keyof typeof categorySchemas, ...Array<keyof typeof categorySchemas>];

export const handCreateInputSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(5000),
  category: z.enum(categories),
  asset: z.enum(["USDC", "USDT"]),
  amount: amountInput,
  deadlineAt: z.coerce.date(),
  slaHours: z.number().int().min(1).max(8760).optional(),
  safetyAttestation: taskSafetyAttestation,
});

type HandRow = {
  id: string;
  client_wallet: string;
  provider_wallet: string | null;
  title: string;
  description: string;
  asset_mint: string;
  amount_atomic: string;
  status: string;
  deadline_at: Date | null;
  category: keyof typeof categorySchemas;
  proof_schema: string[];
  sla_hours: number | null;
  created_at: Date;
  updated_at: Date;
  escrow_address?: string;
};

function atomicAmount(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (value <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return value.toString();
}

function mintFor(asset: "USDC" | "USDT") {
  const configured = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!configured) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try { return new PublicKey(configured).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid mint configuration.`); }
}

export function publicHand(row: HandRow) {
  return {
    id: row.id,
    clientWallet: row.client_wallet,
    providerWallet: row.provider_wallet,
    title: row.title,
    description: row.description,
    assetMint: row.asset_mint,
    amountAtomic: row.amount_atomic,
    status: row.status,
    deadlineAt: row.deadline_at,
    category: row.category,
    proofSchema: row.proof_schema,
    slaHours: row.sla_hours,
    escrowAddress: row.escrow_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createHandForWallet(
  user: { userId: string; walletAddress: string },
  idempotencyKey: string | undefined,
  value: unknown,
) {
  const input = handCreateInputSchema.parse(value);
  assertSafeTaskText(input.title, input.description);
  if (input.deadlineAt.getTime() <= Date.now() + 60_000) {
    throw new ApiError(400, "invalid_deadline", "The deadline must be at least one minute in the future.");
  }
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  }

  const mint = mintFor(input.asset);
  const amountAtomic = atomicAmount(input.amount);
  const proofSchema = categorySchemas[input.category];
  const requestHash = createHash("sha256").update(JSON.stringify({
    title: input.title,
    description: input.description,
    category: input.category,
    asset: input.asset,
    mint,
    amountAtomic,
    deadlineAt: input.deadlineAt.toISOString(),
    slaHours: input.slaHours ?? null,
  })).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [user.userId, idempotencyKey]);
    const existing = await client.query<HandRow & { request_hash: string | null }>(
      `SELECT c.*, w.public_key AS escrow_address
         FROM commissions c LEFT JOIN commission_escrow_wallets w ON w.commission_id = c.id
        WHERE c.client_user_id = $1 AND c.idempotency_key = $2`, [user.userId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different task details.");
      }
      await client.query("COMMIT");
      return { data: publicHand(existing.rows[0]), idempotentReplay: true };
    }
    const inserted = await client.query<HandRow>(
      `INSERT INTO commissions
         (client_user_id, client_wallet, title, description, asset_mint, amount_atomic, status,
          deadline_at, idempotency_key, request_hash, work_type, category, proof_schema, work_category, sla_hours)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, 'hand', $10, $11::jsonb, $12, $13)
       RETURNING *`,
      [user.userId, user.walletAddress, input.title, input.description, mint, amountAtomic,
        input.deadlineAt, idempotencyKey, requestHash, input.category, JSON.stringify(proofSchema),
        input.category, input.slaHours ?? null],
    );
    const escrow = await createCommissionEscrowWallet(client, inserted.rows[0].id);
    await client.query("COMMIT");
    return { data: publicHand({ ...inserted.rows[0], escrow_address: escrow.publicKey }), idempotentReplay: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
