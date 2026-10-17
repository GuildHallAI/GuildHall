import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const ownerWallet = Keypair.generate().publicKey.toBase58();
const memberWallet = Keypair.generate().publicKey.toBase58();
const clientWallet = Keypair.generate().publicKey.toBase58();
let ownerId = "";
let memberId = "";
let clientId = "";
let guildId = "";
let depositId = "";
let commissionId = "";
let workRecordId = "";

beforeAll(async () => {
  await migrate();
  markStartupReady();
  const owner = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [ownerWallet]);
  const member = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [memberWallet]);
  const client = await pool.query<{ id: string }>("INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id", [clientWallet]);
  ownerId = owner.rows[0]!.id;
  memberId = member.rows[0]!.id;
  clientId = client.rows[0]!.id;

  const guild = await pool.query<{ id: string }>(
    `INSERT INTO guilds
       (owner_user_id, name, description, sla_hours, bond_target_atomic, bond_wallet_public_key,
        encrypted_secret_key, encryption_nonce, encryption_auth_tag, cluster, bond_mint, status)
     VALUES ($1, 'Board test guild', 'A bonded team for integration coverage.', 72, 1000000, $2,
        $3, $4, $5, 'devnet', $6, 'active') RETURNING id`,
    [ownerId, Keypair.generate().publicKey.toBase58(), Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16), process.env.USDC_MINT],
  );
  guildId = guild.rows[0]!.id;
  await pool.query("INSERT INTO guild_members (guild_id, user_id, role, share_bps) VALUES ($1, $2, 'lead', 6000), ($1, $3, 'member', 4000)", [guildId, ownerId, memberId]);
  const deposit = await pool.query<{ id: string }>(
    `INSERT INTO guild_bond_deposits
       (guild_id, depositor_user_id, depositor_wallet, amount_atomic, transaction_signature,
        recent_blockhash, last_valid_block_height, confirmed_at)
     VALUES ($1, $2, $3, 1000000, $4, 'guild-board-test-blockhash', 100, now()) RETURNING id`,
    [guildId, ownerId, ownerWallet, `guild-board-test-${crypto.randomUUID()}`],
  );
  depositId = deposit.rows[0]!.id;

  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions
       (client_user_id, client_wallet, provider_user_id, provider_wallet, title, description,
        asset_mint, amount_atomic, status, deadline_at)
     VALUES ($1, $2, $3, $4, 'Guild board completed work', 'Fixture record.', $5, 5000000, 'complete', now() + interval '1 day')
     RETURNING id`,
    [clientId, clientWallet, ownerId, ownerWallet, process.env.USDC_MINT],
  );
  commissionId = commission.rows[0]!.id;
  await pool.query("INSERT INTO guild_commissions (commission_id, guild_id, lead_user_id, sla_hours) VALUES ($1, $2, $3, 72)", [commissionId, guildId, ownerId]);
  const workRecord = await pool.query<{ id: string }>(
    `INSERT INTO work_records
       (commission_id, client_user_id, provider_user_id, asset_mint, amount_atomic, paid_amount_atomic, outcome)
     VALUES ($1, $2, $3, $4, 5000000, 4900000, 'accepted') RETURNING id`,
    [commissionId, clientId, ownerId, process.env.USDC_MINT],
  );
  workRecordId = workRecord.rows[0]!.id;
});

afterAll(async () => {
  if (workRecordId) await pool.query("DELETE FROM work_records WHERE id = $1", [workRecordId]);
  if (commissionId) {
    await pool.query("DELETE FROM guild_commissions WHERE commission_id = $1", [commissionId]);
    await pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]);
  }
  if (depositId) await pool.query("DELETE FROM guild_bond_deposits WHERE id = $1", [depositId]);
  if (guildId) {
    await pool.query("DELETE FROM guild_members WHERE guild_id = $1", [guildId]);
    await pool.query("DELETE FROM guilds WHERE id = $1", [guildId]);
  }
  if (ownerId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [ownerId]);
  if (memberId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [memberId]);
  if (clientId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [clientId]);
});

describe("GET /v1/guilds/board", () => {
  it("lists active bonded Guilds with their split and settled-work record", async () => {
    const response = await request(app).get("/v1/guilds/board").expect(200);
    const guild = response.body.data.find((entry: { guildId: string }) => entry.guildId === guildId);

    expect(guild).toBeDefined();
    expect(guild.name).toBe("Board test guild");
    expect(guild.ownerWallet).toBe(ownerWallet);
    expect(guild.memberCount).toBe(2);
    expect(guild.members).toEqual([
      { walletAddress: ownerWallet, shareBps: 6000 },
      { walletAddress: memberWallet, shareBps: 4000 },
    ]);
    expect(guild.settledJobs).toBe(1);
    expect(guild.totalPaidAtomic).toBe("4900000");
    expect(guild.acceptanceRatePercent).toBe(100);
  });
});
