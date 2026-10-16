import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import request from "supertest";
import { app, markStartupReady } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { pool } from "../src/db/index.js";

const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

beforeAll(async () => {
  await migrate();
  markStartupReady();
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM commission_escrow_wallets
      WHERE commission_id IN (SELECT id FROM commissions WHERE client_user_id = ANY($1::uuid[]))`,
    [await userIdsForWallets()],
  );
  await pool.query("DELETE FROM commissions WHERE client_user_id = ANY($1::uuid[])", [await userIdsForWallets()]);
  await pool.query("DELETE FROM auth_nonces WHERE wallet_address = ANY($1::text[])", [
    wallets.map((wallet) => wallet.publicKey.toBase58()),
  ]);
  await pool.query("DELETE FROM wallet_users WHERE wallet_address = ANY($1::text[])", [
    wallets.map((wallet) => wallet.publicKey.toBase58()),
  ]);
});

async function userIdsForWallets() {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM wallet_users WHERE wallet_address = ANY($1::text[])",
    [wallets.map((wallet) => wallet.publicKey.toBase58())],
  );
  return result.rows.map((row) => row.id);
}

describe("wallet authentication", () => {
  it("accepts a valid signature once, then rejects replay and revoked sessions", async () => {
    const wallet = wallets[0]!;
    const walletAddress = wallet.publicKey.toBase58();
    const challenge = await request(app)
      .post("/v1/auth/nonce")
      .send({ walletAddress })
      .expect(201);
    const signature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(challenge.body.data.message),
      wallet.secretKey,
    ));

    const session = await request(app)
      .post("/v1/auth/verify")
      .send({ walletAddress, nonce: challenge.body.data.nonce, signature })
      .expect(201);
    const token = session.body.data.token as string;

    await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${token}`)
      .expect(200).expect(({ body }) => expect(body.data.walletAddress).toBe(walletAddress));

    const commissionRequest = request(app)
      .post("/v1/commissions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `audit-${challenge.body.data.nonce}`)
      .send({
        title: "Audit integration commission",
        description: "Test commission used to verify idempotency and ownership checks.",
        asset: "USDC",
        amount: "1",
        category: "research",
        requiresTribunal: false,
        safetyAttestation: true,
      });
    const createdCommission = await commissionRequest.expect(201);
    const commissionId = createdCommission.body.data.id as string;
    expect(createdCommission.body.data.escrowAddress).toBeString();
    expect(createdCommission.body.data.amountAtomic).toBe("1000000");

    await request(app)
      .post("/v1/commissions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `audit-${challenge.body.data.nonce}`)
      .send({
        title: "Audit integration commission",
        description: "Test commission used to verify idempotency and ownership checks.",
        asset: "USDC",
        amount: "1",
        category: "research",
        requiresTribunal: false,
        safetyAttestation: true,
      })
      .expect(200)
      .expect(({ body }) => expect(body.idempotentReplay).toBe(true));

    await request(app)
      .post("/v1/commissions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `audit-${challenge.body.data.nonce}`)
      .send({
        title: "Audit integration commission",
        description: "Test commission used to verify idempotency and ownership checks.",
        asset: "USDC",
        amount: "2",
        category: "research",
        requiresTribunal: false,
        safetyAttestation: true,
      })
      .expect(409);

    await request(app)
      .post(`/v1/commissions/${commissionId}/accept`)
      .set("Authorization", `Bearer ${token}`)
      .expect(409);

    const registeredAgent = await request(app)
      .post("/v1/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Audit Worker", description: "Integration-test worker", categories: ["research"], capabilities: ["research"], expiresInDays: 30 })
      .expect(201);
    const agentId = registeredAgent.body.data.id as string;
    const originalRuntimeToken = registeredAgent.body.data.runtimeToken as string;
    expect(originalRuntimeToken.length).toBeGreaterThan(32);
    expect(registeredAgent.body.data).not.toHaveProperty("tokenHash");
    await request(app)
      .get("/v1/agent-runtime/commissions")
      .set("Authorization", `Bearer ${originalRuntimeToken}`)
      .expect(200);

    const replacement = await request(app)
      .post(`/v1/agents/${agentId}/runtime-token`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expiresInDays: 14 })
      .expect(201);
    const replacementToken = replacement.body.data.runtimeToken as string;
    expect(replacementToken).not.toBe(originalRuntimeToken);
    await request(app)
      .get("/v1/agent-runtime/commissions")
      .set("Authorization", `Bearer ${originalRuntimeToken}`)
      .expect(401);
    await request(app)
      .get("/v1/agent-runtime/commissions")
      .set("Authorization", `Bearer ${replacementToken}`)
      .expect(200);

    const otherWallet = wallets[1]!;
    const otherAddress = otherWallet.publicKey.toBase58();
    const otherChallenge = await request(app).post("/v1/auth/nonce").send({ walletAddress: otherAddress }).expect(201);
    const otherSignature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(otherChallenge.body.data.message),
      otherWallet.secretKey,
    ));
    const otherSession = await request(app).post("/v1/auth/verify").send({
      walletAddress: otherAddress,
      nonce: otherChallenge.body.data.nonce,
      signature: otherSignature,
    }).expect(201);
    await request(app)
      .post(`/v1/agents/${agentId}/runtime-token`)
      .set("Authorization", `Bearer ${otherSession.body.data.token}`)
      .send({ expiresInDays: 14 })
      .expect(404);

    await request(app)
      .post("/v1/auth/verify")
      .send({ walletAddress, nonce: challenge.body.data.nonce, signature })
      .expect(401);

    await request(app).delete("/v1/auth/session").set("Authorization", `Bearer ${token}`).expect(204);
    await request(app).get("/v1/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("rejects a signature from a different wallet", async () => {
    const wallet = wallets[0]!;
    const attacker = wallets[1]!;
    const walletAddress = wallet.publicKey.toBase58();
    const challenge = await request(app)
      .post("/v1/auth/nonce")
      .send({ walletAddress })
      .expect(201);
    const signature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(challenge.body.data.message),
      attacker.secretKey,
    ));

    await request(app)
      .post("/v1/auth/verify")
      .send({ walletAddress, nonce: challenge.body.data.nonce, signature })
      .expect(401);

    const validSignature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(challenge.body.data.message),
      wallet.secretKey,
    ));
    await request(app)
      .post("/v1/auth/verify")
      .send({ walletAddress, nonce: challenge.body.data.nonce, signature: validSignature })
      .expect(201);
  });

  it("allows only one of two concurrent attempts to consume a nonce", async () => {
    const wallet = wallets[1]!;
    const walletAddress = wallet.publicKey.toBase58();
    const challenge = await request(app)
      .post("/v1/auth/nonce")
      .send({ walletAddress })
      .expect(201);
    const signature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(challenge.body.data.message),
      wallet.secretKey,
    ));
    const payload = { walletAddress, nonce: challenge.body.data.nonce, signature };
    const attempts = await Promise.all([
      request(app).post("/v1/auth/verify").send(payload),
      request(app).post("/v1/auth/verify").send(payload),
    ]);

    expect(attempts.map((result) => result.status).sort()).toEqual([201, 401]);
  });

  it("keeps an active sign-in challenge valid across repeated nonce requests", async () => {
    const wallet = wallets[2]!;
    const walletAddress = wallet.publicKey.toBase58();
    const first = await request(app).post("/v1/auth/nonce").send({ walletAddress }).expect(201);
    for (let i = 0; i < 8; i += 1) {
      const repeated = await request(app).post("/v1/auth/nonce").send({ walletAddress }).expect(201);
      expect(repeated.body.data.nonce).toBe(first.body.data.nonce);
      expect(repeated.body.data.message).toBe(first.body.data.message);
    }
    const signature = bs58.encode(nacl.sign.detached(
      new TextEncoder().encode(first.body.data.message),
      wallet.secretKey,
    ));
    await request(app).post("/v1/auth/verify").send({
      walletAddress,
      nonce: first.body.data.nonce,
      signature,
    }).expect(201);
  });

  it("rejects malformed wallet and signature inputs before database access", async () => {
    await request(app).post("/v1/auth/nonce").send({ walletAddress: "not-a-wallet" }).expect(400);
    await request(app).post("/v1/auth/verify").send({
      walletAddress: wallets[0]!.publicKey.toBase58(),
      nonce: "bad",
      signature: "bad",
    }).expect(400);
  });

  it("rejects unauthenticated reconciler calls and invalid limits before processing queues", async () => {
    await request(app).post("/internal/reconcile").send({ limit: 1 }).expect(401);
    await request(app)
      .post("/internal/reconcile")
      .set("X-Cron-Secret", "not-the-cron-secret")
      .send({ limit: 1 })
      .expect(401);
    await request(app)
      .post("/internal/reconcile")
      .set("X-Cron-Secret", "guildhall-ci-only-cron-secret-for-integration-tests")
      .send({ limit: 101 })
      .expect(400);
  });
});
