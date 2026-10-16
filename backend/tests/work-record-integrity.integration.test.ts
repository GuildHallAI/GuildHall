import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const userIds: string[] = [];
const commissionIds: string[] = [];
const recordIds: string[] = [];
let agentId = "";
const users: Record<string, string> = {};

async function user(name: string) {
  const row = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [Keypair.generate().publicKey.toBase58()]);
  userIds.push(row.rows[0]!.id);
  users[name] = row.rows[0]!.id;
  return row.rows[0]!.id;
}

async function settled(client: string, provider: string, amountAtomic: number, daysAgo: number, providerAgentId: string | null = null) {
  const wallets = await pool.query<{ id: string; wallet_address: string }>("SELECT id, wallet_address FROM wallet_users WHERE id = ANY($1::uuid[])", [[users[client], users[provider]]]);
  const walletOf = (id: string) => wallets.rows.find((row) => row.id === id)!.wallet_address;
  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions (client_user_id, provider_user_id, client_wallet, provider_wallet, title, description, asset_mint,
       amount_atomic, status, deadline_at, provider_agent_id)
     VALUES ($1, $2, $3, $4, 'Integrity check', 'Integrity check', $5, $6, 'complete', now() + interval '1 day', $7) RETURNING id`,
    [users[client], users[provider], walletOf(users[client]!), walletOf(users[provider]!), process.env.USDC_MINT, amountAtomic, providerAgentId],
  );
  commissionIds.push(commission.rows[0]!.id);
  const record = await pool.query<{ id: string }>(
    `INSERT INTO work_records (commission_id, client_user_id, provider_user_id, asset_mint, amount_atomic, paid_amount_atomic,
       outcome, finalized_at, provider_agent_id)
     VALUES ($1, $2, $3, $4, $5::numeric, $5::numeric * 98 / 100, 'accepted', now() - make_interval(days => $6), $7) RETURNING id`,
    [commission.rows[0]!.id, users[client], users[provider], process.env.USDC_MINT, amountAtomic, daysAgo, providerAgentId],
  );
  recordIds.push(record.rows[0]!.id);
  return record.rows[0]!.id;
}

async function flagsFor(recordId: string) {
  const row = await pool.query<{ flags: string[]; reputation_weight: string }>(
    "SELECT flags, reputation_weight::text FROM work_record_integrity_flags WHERE work_record_id = $1", [recordId],
  );
  return { flags: row.rows[0]!.flags, weight: Number(row.rows[0]!.reputation_weight) };
}

beforeAll(async () => {
  await migrate();
  markStartupReady();
  for (const name of ["alice", "bob", "carol", "dave", "erin", "frank", "gina", "hank", "owner", "buyer"]) await user(name);
  const agent = await pool.query<{ id: string }>(
    `INSERT INTO work_agents (owner_user_id, owner_wallet, name, description)
     SELECT id, wallet_address, $2, 'Integrity test agent' FROM wallet_users WHERE id = $1 RETURNING id`,
    [users.owner, `Integrity Agent ${crypto.randomUUID().slice(0, 8)}`],
  );
  agentId = agent.rows[0]!.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM work_record_feedback WHERE work_record_id = ANY($1::uuid[])", [recordIds]);
  await pool.query("DELETE FROM work_records WHERE id = ANY($1::uuid[])", [recordIds]);
  await pool.query("DELETE FROM commissions WHERE id = ANY($1::uuid[])", [commissionIds]);
  await pool.query("DELETE FROM work_agents WHERE id = $1", [agentId]);
  await pool.query("DELETE FROM wallet_users WHERE id = ANY($1::uuid[])", [userIds]);
});

describe("work_record_integrity_flags", () => {
  it("counts ordinary paid work in full", async () => {
    expect(await flagsFor(await settled("alice", "bob", 5_000_000, 1))).toEqual({ flags: [], weight: 1 });
  });

  it("removes both sides of a reciprocal payment loop", async () => {
    const first = await settled("carol", "dave", 5_000_000, 3);
    const second = await settled("dave", "carol", 5_000_000, 2);
    expect(await flagsFor(first)).toEqual({ flags: ["reciprocal_pair"], weight: 0 });
    expect(await flagsFor(second)).toEqual({ flags: ["reciprocal_pair"], weight: 0 });
  });

  it("halves the fourth job from the same client within 30 days", async () => {
    const jobs = [];
    for (const daysAgo of [20, 15, 10, 5]) jobs.push(await settled("erin", "frank", 5_000_000, daysAgo));
    expect((await flagsFor(jobs[2]!)).flags).toEqual([]);
    expect(await flagsFor(jobs[3]!)).toEqual({ flags: ["repeat_pair"], weight: 0.5 });
  });

  it("halves micro payments", async () => {
    expect(await flagsFor(await settled("gina", "hank", 500_000, 1))).toEqual({ flags: ["micro_payment"], weight: 0.5 });
  });

  it("removes an owner hiring their own agent", async () => {
    expect(await flagsFor(await settled("owner", "hank", 5_000_000, 1, agentId))).toEqual({ flags: ["self_dealing"], weight: 0 });
  });
});

describe("GET /v1/agents/:id/record", () => {
  it("keeps self-dealing out of the agent's reputation", async () => {
    const organic = await settled("buyer", "owner", 5_000_000, 1, agentId);
    const selfDealt = recordIds[recordIds.length - 2]!;
    await pool.query(
      `INSERT INTO work_record_feedback (work_record_id, reviewer_user_id, target_user_id, rating, comment, weight_atomic)
       VALUES ($1, $2, $3, 5, 'Solid work', 4900000), ($4, $5, $6, 1, 'Owner-funded review', 4900000)`,
      [organic, users.buyer, users.owner, selfDealt, users.owner, users.hank],
    );
    const body = (await request(app).get(`/v1/agents/${agentId}/record`).expect(200)).body.data;
    expect(body.record.totalSettledCommissions).toBe(2);
    expect(body.record.settledCommissions).toBe(1);
    expect(body.record.excludedCommissions).toBe(1);
    expect(body.record.distinctClients).toBe(1);
    expect(body.record.weightedRating).toBe(5);
    const flagged = body.workRecords.find((work: { integrityFlags: string[] }) => work.integrityFlags.length);
    expect(flagged.integrityFlags).toEqual(["self_dealing"]);
    expect(flagged.reputationWeight).toBe(0);
  });
});
