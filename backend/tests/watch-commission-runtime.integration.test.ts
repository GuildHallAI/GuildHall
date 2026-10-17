import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import { hashAgentRuntimeToken } from "../src/agent-auth.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const ownerWallet = Keypair.generate().publicKey.toBase58();
const clientWallet = Keypair.generate().publicKey.toBase58();
const runtimeToken = `gh_agent_${crypto.randomUUID().replaceAll("-", "")}`;
const idempotencyKey = crypto.randomUUID();
let ownerId = "";
let clientId = "";
let agentId = "";
let commissionId = "";

beforeAll(async () => {
  await migrate();
  markStartupReady();
  const owner = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [ownerWallet]);
  const client = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [clientWallet]);
  ownerId = owner.rows[0]!.id;
  clientId = client.rows[0]!.id;
  const agent = await pool.query<{ id: string }>(
    `INSERT INTO work_agents (owner_user_id, owner_wallet, name, description, categories, capabilities)
     VALUES ($1, $2, $3, 'Watch Commission integration agent.', ARRAY['watch'], ARRAY['market monitoring']) RETURNING id`,
    [ownerId, ownerWallet, `Watch test ${crypto.randomUUID()}`],
  );
  agentId = agent.rows[0]!.id;
  await pool.query("INSERT INTO agent_runtime_tokens (agent_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [agentId, hashAgentRuntimeToken(runtimeToken)]);
  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions
       (client_user_id, client_wallet, title, description, asset_mint, amount_atomic, status, deadline_at,
        work_type, work_category, watch_terms, funded_at)
     VALUES ($1, $2, 'Watch a BTC price deviation', 'Report the configured market condition with evidence.',
        $3, 5000000, 'funded', now() + interval '2 days', 'watch', 'watch',
        $4::jsonb, now() - interval '1 hour') RETURNING id`,
    [clientId, clientWallet, process.env.USDC_MINT,
      JSON.stringify({ venue: "Example Venue", market: "BTC-PERP", monitoringHours: 24,
        trigger: { type: "deviation", thresholdPercent: 1, persistenceSeconds: 5 } })],
  );
  commissionId = commission.rows[0]!.id;
});

afterAll(async () => {
  if (commissionId) await pool.query("DELETE FROM watch_commission_alerts WHERE commission_id = $1", [commissionId]);
  if (commissionId) await pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]);
  if (agentId) await pool.query("DELETE FROM work_agents WHERE id = $1", [agentId]);
  if (ownerId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [ownerId]);
  if (clientId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [clientId]);
});

describe("Watch Commission runtime API", () => {
  it("lets an assigned watch agent claim work and submit idempotent evidence alerts", async () => {
    const headers = { Authorization: `Bearer ${runtimeToken}` };
    const listed = await request(app).get("/v1/agent-runtime/commissions").set(headers).expect(200);
    const commission = listed.body.data.find((entry: { id: string }) => entry.id === commissionId);
    expect(commission.workType).toBe("watch");
    expect(commission.watchTerms.trigger.type).toBe("deviation");

    await request(app).post(`/v1/agent-runtime/commissions/${commissionId}/claim`).set(headers).send({}).expect(200);
    const alert = {
      idempotencyKey,
      alertType: "deviation",
      observedAt: new Date().toISOString(),
      observedValue: "101.2",
      referenceValue: "100.0",
      evidenceUrl: "https://example.com/market-snapshot",
      notes: "Deviation persisted beyond the configured interval.",
    };
    const created = await request(app).post(`/v1/agent-runtime/commissions/${commissionId}/watch-alerts`).set(headers).send(alert).expect(201);
    expect(created.body.data.payloadDigest).toMatch(/^[0-9a-f]{64}$/);

    const replay = await request(app).post(`/v1/agent-runtime/commissions/${commissionId}/watch-alerts`).set(headers).send(alert).expect(200);
    expect(replay.body.idempotentReplay).toBe(true);

    await request(app).post(`/v1/agent-runtime/commissions/${commissionId}/watch-alerts`).set(headers)
      .send({ ...alert, idempotencyKey: crypto.randomUUID(), alertType: "stale" }).expect(400);
  });
});
