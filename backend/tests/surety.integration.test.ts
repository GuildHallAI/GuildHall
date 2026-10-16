import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { pool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { markOperationConfirmed } from "../src/surety-pool.js";

const ownerWallet = Keypair.generate().publicKey.toBase58();
let userId = "";
let commissionId = "";
let policyId = "";
let poolOperationIds: string[] = [];
let attemptIds: string[] = [];
let withdrawalIds: string[] = [];

beforeAll(async () => {
  await migrate();
  const user = await pool.query<{ id: string }>(
    "INSERT INTO wallet_users (wallet_address) VALUES ($1) RETURNING id",
    [ownerWallet],
  );
  userId = user.rows[0]!.id;
  const commission = await pool.query<{ id: string }>(
    `INSERT INTO commissions (client_user_id, client_wallet, title, description, asset_mint, amount_atomic, status, deadline_at)
     VALUES ($1, $2, 'Surety integration check', 'Isolated Surety ledger test', $3, 1000000, 'complete', now() + interval '1 day') RETURNING id`,
    [userId, ownerWallet, process.env.USDC_MINT],
  );
  commissionId = commission.rows[0]!.id;
  const policy = await pool.query<{ id: string }>(
    `INSERT INTO surety_policies
       (commission_id, client_user_id, client_wallet, work_category, coverage_atomic, premium_atomic,
        treasury_fee_atomic, premium_rate_bps, state, expires_at, premium_signature, premium_confirmed_at)
     VALUES ($1, $2, $3, 'research', 30, 1, 0, 100, 'claim_pending', now() + interval '1 day', $4, now())
     RETURNING id`,
    [commissionId, userId, ownerWallet, `policy-${crypto.randomUUID()}`],
  );
  policyId = policy.rows[0]!.id;
  await pool.query(
    `INSERT INTO surety_pool
       (id, wallet_public_key, encrypted_secret_key, encryption_nonce, encryption_auth_tag,
        encryption_key_version, cluster, asset_mint, accounted_balance_atomic)
     VALUES (1, $1, $2, $3, $4, 1, 'devnet', $5, 100)`,
    [`pool-${crypto.randomUUID()}`, Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16), process.env.USDC_MINT],
  );
  await pool.query(
    "INSERT INTO surety_pool_share_accounts (user_id, shares_atomic) VALUES ($1, 100)",
    [userId],
  );
});

afterAll(async () => {
  if (attemptIds.length) await pool.query("DELETE FROM surety_pool_operation_attempts WHERE id = ANY($1::uuid[])", [attemptIds]);
  if (poolOperationIds.length) await pool.query("DELETE FROM surety_pool_operations WHERE id = ANY($1::uuid[])", [poolOperationIds]);
  if (withdrawalIds.length) await pool.query("DELETE FROM surety_withdrawal_requests WHERE id = ANY($1::uuid[])", [withdrawalIds]);
  if (policyId) await pool.query("DELETE FROM surety_policies WHERE id = $1", [policyId]);
  if (commissionId) await pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]);
  await pool.query("DELETE FROM surety_pool_share_accounts WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM surety_pool WHERE id = 1");
  if (userId) await pool.query("DELETE FROM wallet_users WHERE id = $1", [userId]);
});

async function prepareWithdrawal(amountAtomic: number, sharesAtomic: number) {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO surety_withdrawal_requests (user_id, wallet_address, shares_atomic, state)
     VALUES ($1, $2, $3, 'processing') RETURNING id`,
    [userId, ownerWallet, sharesAtomic],
  );
  withdrawalIds.push(request.rows[0]!.id);
  const operation = await pool.query<{ id: string }>(
    `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic, shares_atomic, state)
     VALUES ('withdrawal', $1, $2, $3, $4, 'submitted') RETURNING id`,
    [request.rows[0]!.id, ownerWallet, amountAtomic, sharesAtomic],
  );
  poolOperationIds.push(operation.rows[0]!.id);
  const signature = `attempt-${crypto.randomUUID()}`;
  const attempt = await pool.query<{ id: string }>(
    `INSERT INTO surety_pool_operation_attempts
       (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
     VALUES ($1, $2, $3, 'audit-test-blockhash', 100, 'submitted') RETURNING id`,
    [operation.rows[0]!.id, signature, Buffer.from([1])],
  );
  attemptIds.push(attempt.rows[0]!.id);
  return { requestId: request.rows[0]!.id, operationId: operation.rows[0]!.id, attemptId: attempt.rows[0]!.id,
    amountAtomic: String(amountAtomic), sharesAtomic: String(sharesAtomic), signature };
}

describe("Surety confirmation ledger invariants", () => {
  it("atomically confirms a claim and debits the accounted balance exactly once", async () => {
    const signature = `claim-${crypto.randomUUID()}`;
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO surety_pool_operations (kind, reference_id, destination_wallet, amount_atomic, state)
       VALUES ('claim', $1, $2, 20, 'submitted') RETURNING id`,
      [policyId, ownerWallet],
    );
    poolOperationIds.push(operation.rows[0]!.id);
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO surety_pool_operation_attempts
         (operation_id, transaction_signature, signed_transaction, recent_blockhash, last_valid_block_height, state)
       VALUES ($1, $2, $3, 'audit-test-blockhash', 100, 'submitted') RETURNING id`,
      [operation.rows[0]!.id, signature, Buffer.from([1])],
    );
    attemptIds.push(attempt.rows[0]!.id);

    const confirmation = { id: operation.rows[0]!.id, kind: "claim", reference_id: policyId,
      amount_atomic: "20", shares_atomic: null };
    await Promise.all([
      markOperationConfirmed(confirmation, attempt.rows[0]!.id, signature),
      markOperationConfirmed(confirmation, attempt.rows[0]!.id, signature),
    ]);

    const [balance, policy, confirmedOperation, confirmedAttempt] = await Promise.all([
      pool.query<{ amount: string }>("SELECT accounted_balance_atomic::text AS amount FROM surety_pool WHERE id = 1"),
      pool.query<{ state: string }>("SELECT state FROM surety_policies WHERE id = $1", [policyId]),
      pool.query<{ state: string; signature: string }>("SELECT state, transaction_signature AS signature FROM surety_pool_operations WHERE id = $1", [operation.rows[0]!.id]),
      pool.query<{ state: string }>("SELECT state FROM surety_pool_operation_attempts WHERE id = $1", [attempt.rows[0]!.id]),
    ]);
    expect(balance.rows[0]!.amount).toBe("80");
    expect(policy.rows[0]!.state).toBe("claimed");
    expect(confirmedOperation.rows[0]!.state).toBe("confirmed");
    expect(confirmedOperation.rows[0]!.signature).toBe(signature);
    expect(confirmedAttempt.rows[0]!.state).toBe("confirmed");
  });

  it("rolls back every ledger update when a payout would make pool balance negative", async () => {
    const overdraw = await prepareWithdrawal(100, 50);
    await expect(markOperationConfirmed({ id: overdraw.operationId, kind: "withdrawal",
      reference_id: overdraw.requestId, amount_atomic: overdraw.amountAtomic,
      shares_atomic: overdraw.sharesAtomic }, overdraw.attemptId, overdraw.signature)).rejects.toThrow(
      "Surety pool accounted balance would become negative.",
    );

    const [balance, shares, request, operation, attempt] = await Promise.all([
      pool.query<{ amount: string }>("SELECT accounted_balance_atomic::text AS amount FROM surety_pool WHERE id = 1"),
      pool.query<{ amount: string }>("SELECT shares_atomic::text AS amount FROM surety_pool_share_accounts WHERE user_id = $1", [userId]),
      pool.query<{ state: string }>("SELECT state FROM surety_withdrawal_requests WHERE id = $1", [overdraw.requestId]),
      pool.query<{ state: string; signature: string | null }>("SELECT state, transaction_signature AS signature FROM surety_pool_operations WHERE id = $1", [overdraw.operationId]),
      pool.query<{ state: string }>("SELECT state FROM surety_pool_operation_attempts WHERE id = $1", [overdraw.attemptId]),
    ]);
    expect(balance.rows[0]!.amount).toBe("80");
    expect(shares.rows[0]!.amount).toBe("100");
    expect(request.rows[0]!.state).toBe("processing");
    expect(operation.rows[0]!.state).toBe("submitted");
    expect(operation.rows[0]!.signature).toBeNull();
    expect(attempt.rows[0]!.state).toBe("submitted");
  });

  it("confirms a withdrawal by debiting matching shares and token balance", async () => {
    const withdrawal = await prepareWithdrawal(30, 30);
    await markOperationConfirmed({ id: withdrawal.operationId, kind: "withdrawal",
      reference_id: withdrawal.requestId, amount_atomic: withdrawal.amountAtomic,
      shares_atomic: withdrawal.sharesAtomic }, withdrawal.attemptId, withdrawal.signature);

    const [balance, shares, request, operation] = await Promise.all([
      pool.query<{ amount: string }>("SELECT accounted_balance_atomic::text AS amount FROM surety_pool WHERE id = 1"),
      pool.query<{ amount: string }>("SELECT shares_atomic::text AS amount FROM surety_pool_share_accounts WHERE user_id = $1", [userId]),
      pool.query<{ state: string }>("SELECT state FROM surety_withdrawal_requests WHERE id = $1", [withdrawal.requestId]),
      pool.query<{ state: string }>("SELECT state FROM surety_pool_operations WHERE id = $1", [withdrawal.operationId]),
    ]);
    expect(balance.rows[0]!.amount).toBe("50");
    expect(shares.rows[0]!.amount).toBe("70");
    expect(request.rows[0]!.state).toBe("confirmed");
    expect(operation.rows[0]!.state).toBe("confirmed");
  });
});
