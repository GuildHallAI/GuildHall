import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import { settlementLines } from "../src/commission-receipts.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { commissionDistribution } from "../src/escrow-settlement.js";
import { enqueueWorkRecordChainOperation } from "../src/onchain-work-records.js";

const wallet = () => Keypair.generate().publicKey.toBase58();
const signature = () => `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.padEnd(88, "A");
const clientWallet = wallet();
const providerWallet = wallet();
const escrowWallet = wallet();
const fee = { worker: wallet(), treasury: wallet(), staker: wallet() };
const signatures = { funding: signature(), release: signature(), record: signature() };
const userIds: string[] = [];
const commissionIds: string[] = [];
let settledId = "";
let unfundedId = "";

async function insertCommission(status: string, fundingSignature: string | null) {
  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions (client_user_id, provider_user_id, client_wallet, provider_wallet, title, description,
       asset_mint, amount_atomic, status, deadline_at, funding_signature, funded_at)
     VALUES ($1, $2, $3, $4, 'Receipt integration check', 'Private brief text', $5, 5000000, $6,
       now() + interval '1 day', $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [userIds[0], userIds[1], clientWallet, providerWallet, process.env.USDC_MINT, status, fundingSignature],
  );
  commissionIds.push(commission.rows[0]!.id);
  return commission.rows[0]!.id;
}

beforeAll(async () => {
  await migrate();
  markStartupReady();
  for (const address of [clientWallet, providerWallet]) {
    const user = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [address]);
    userIds.push(user.rows[0]!.id);
  }
  settledId = await insertCommission("complete", signatures.funding);
  unfundedId = await insertCommission("open", null);
  await pool.query(
    `INSERT INTO commission_escrow_wallets (commission_id, public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag, cluster)
     VALUES ($1, $2, $3, $4, $5, 'devnet')`,
    [settledId, escrowWallet, Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16)],
  );
  const { feeAtomic, distribution } = commissionDistribution("5000000");
  await pool.query(
    `INSERT INTO commission_escrow_operations
       (commission_id, idempotency_key, operation, asset_kind, mint, amount_atomic, destination, state, transaction_signature)
     VALUES ($1, $2, 'fund', 'spl', $3, 5000000, $4, 'confirmed', $5)`,
    [settledId, `fund:${signatures.funding}`, process.env.USDC_MINT, escrowWallet, signatures.funding],
  );
  await pool.query(
    `INSERT INTO commission_escrow_operations
       (commission_id, idempotency_key, operation, asset_kind, mint, amount_atomic, destination, state,
        transaction_signature, fee_atomic, distribution)
     VALUES ($1, $2, 'release', 'spl', $3, 5000000, $4, 'confirmed', $5, $6, $7::jsonb)`,
    [settledId, `release:${settledId}`, process.env.USDC_MINT, providerWallet, signatures.release, feeAtomic,
      JSON.stringify({ ...distribution, feeWorkerWallet: fee.worker, feeTreasuryWallet: fee.treasury, feeStakerWallet: fee.staker })],
  );
  const record = await pool.query<{ id: string }>(
    `INSERT INTO work_records (commission_id, client_user_id, provider_user_id, asset_mint, amount_atomic, paid_amount_atomic, outcome)
     VALUES ($1, $2, $3, $4, 5000000, $5, 'accepted') RETURNING id`,
    [settledId, userIds[0], userIds[1], process.env.USDC_MINT, distribution.provider],
  );
  const db = await pool.connect();
  try { await enqueueWorkRecordChainOperation(db, record.rows[0]!.id); }
  finally { db.release(); }
  await pool.query(
    "UPDATE work_record_chain_operations SET state = 'confirmed', transaction_signature = $2 WHERE work_record_id = $1",
    [record.rows[0]!.id, signatures.record],
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM work_record_chain_operations WHERE work_record_id IN (SELECT id FROM work_records WHERE commission_id = ANY($1::uuid[]))",
    [commissionIds],
  );
  await pool.query("DELETE FROM work_records WHERE commission_id = ANY($1::uuid[])", [commissionIds]);
  await pool.query("DELETE FROM commission_escrow_operations WHERE commission_id = ANY($1::uuid[])", [commissionIds]);
  await pool.query("DELETE FROM commission_escrow_wallets WHERE commission_id = ANY($1::uuid[])", [commissionIds]);
  await pool.query("DELETE FROM commission_activity WHERE commission_id = ANY($1::uuid[])", [commissionIds]).catch(() => undefined);
  await pool.query("DELETE FROM commissions WHERE id = ANY($1::uuid[])", [commissionIds]);
  await pool.query("DELETE FROM wallet_users WHERE id = ANY($1::uuid[])", [userIds]);
});

describe("GET /v1/commissions/:id/receipt", () => {
  it("lists every settlement transaction and the 80/10/5/5 fee split", async () => {
    const response = await request(app).get(`/v1/commissions/${settledId}/receipt`).expect(200);
    const receipt = response.body.data;
    expect(receipt.settled).toBe(true);
    expect(receipt.outcome).toBe("accepted");
    expect(receipt.feeBps).toBe(200);
    expect(receipt.transactions.map((item: { kind: string }) => item.kind)).toEqual(["funding", "settlement", "work_record"]);
    expect(receipt.transactions[1].url).toBe(`https://solscan.io/tx/${signatures.release}?cluster=devnet`);
    expect(receipt.parties.escrow.wallet).toBe(escrowWallet);
    const byRole = Object.fromEntries(receipt.distribution.map((line: { role: string; amountAtomic: string }) => [line.role, line.amountAtomic]));
    expect(byRole).toEqual({ provider: "4900000", fee_workers: "80000", fee_treasury: "10000", fee_stakers: "5000", fee_burn: "5000" });
    const total = receipt.distribution.reduce((sum: bigint, line: { amountAtomic: string }) => sum + BigInt(line.amountAtomic), 0n);
    expect(total).toBe(5_000_000n);
    expect(receipt.workRecord.recordHashValid).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(receipt.workRecord.payload)).digest("hex")).toBe(receipt.workRecord.recordHash);
    expect(JSON.stringify(receipt)).not.toContain("Private brief text");
  });

  it("refuses a receipt before funding", async () => {
    const response = await request(app).get(`/v1/commissions/${unfundedId}/receipt`).expect(409);
    expect(response.body.error.code).toBe("receipt_not_available");
  });
});

describe("settlementLines", () => {
  it("separates crew payouts and Charter buybacks", () => {
    const lines = settlementLines("release", "1000000", {
      crewWallet1: "A", crewAmount1: "600000", crewBuybackWallet1: "V", crewBuybackAtomic1: "60000",
      crewWallet2: "B", crewAmount2: "380000", workers: "16000", treasury: "2000", stakers: "1000", burn: "1000",
    }, { provider: null, client: "C" });
    expect(lines.map((line) => [line.role, line.wallet, line.amountAtomic])).toEqual([
      ["crew_member", "A", "540000"], ["charter_buyback", "V", "60000"], ["crew_member", "B", "380000"],
      ["fee_workers", null, "16000"], ["fee_treasury", null, "2000"], ["fee_stakers", null, "1000"], ["fee_burn", null, "1000"],
    ]);
  });

  it("returns the full refund to the client", () => {
    expect(settlementLines("refund", "750000", { client: "750000" }, { provider: "P", client: "C" }))
      .toEqual([{ role: "client", wallet: "C", amountAtomic: "750000" }]);
  });
});
