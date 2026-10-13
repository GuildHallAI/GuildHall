import { Router } from "express";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { createCommissionEscrowWallet } from "../escrow-wallets.js";
import { ApiError } from "../http.js";
import { decryptPrivateData, encryptPrivateData } from "../private-data.js";
import { assertSafeTaskText, taskSafetyAttestation } from "../task-policy.js";

const router = Router();
const amountInput = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const uuid = z.string().uuid();
const taskInput = z.object({ title: z.string().trim().min(3).max(160), description: z.string().trim().min(1).max(5000) });

function atomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (result <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
  return result.toString();
}

function mintFor(asset: "USDC" | "USDT") {
  const configured = asset === "USDC" ? config.USDC_MINT : config.USDT_MINT;
  if (!configured) throw new ApiError(503, "asset_unavailable", `${asset} is not configured for this cluster.`);
  try { return new PublicKey(configured).toBase58(); }
  catch { throw new ApiError(503, "asset_misconfigured", `${asset} has an invalid mint configuration.`); }
}

async function crewDetails(crewId: string) {
  const crew = await pool.query<{ id: string; owner_user_id: string; name: string; description: string; created_at: Date }>(
    "SELECT id, owner_user_id, name, description, created_at FROM crews WHERE id = $1", [crewId],
  );
  if (!crew.rows[0]) throw new ApiError(404, "crew_not_found", "Crew not found.");
  const members = await pool.query(
    `SELECT u.id AS user_id, u.wallet_address, m.role, m.joined_at
       FROM crew_members m JOIN wallet_users u ON u.id = m.user_id
      WHERE m.crew_id = $1 ORDER BY CASE WHEN m.role = 'lead' THEN 0 ELSE 1 END, m.joined_at`, [crewId],
  );
  return { ...crew.rows[0], members: members.rows };
}

router.post("/", requireAuth, async (request, response) => {
  const input = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().min(1).max(2000) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const crew = await client.query<{ id: string }>(
      "INSERT INTO crews (owner_user_id, name, description) VALUES ($1, $2, $3) RETURNING id",
      [request.auth!.userId, input.name, input.description],
    );
    await client.query("INSERT INTO crew_members (crew_id, user_id, role) VALUES ($1, $2, 'lead')", [crew.rows[0].id, request.auth!.userId]);
    await client.query("COMMIT");
    response.status(201).json({ data: await crewDetails(crew.rows[0].id) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.get("/mine", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.description, c.owner_user_id, m.role, c.created_at
       FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.user_id = $1
      ORDER BY c.created_at DESC`, [request.auth!.userId],
  );
  response.json({ data: result.rows });
});

router.get("/invitations", requireAuth, async (request, response) => {
  const result = await pool.query(
    `SELECT i.id, i.crew_id, c.name AS crew_name, i.created_at
       FROM crew_invitations i JOIN crews c ON c.id = i.crew_id
      WHERE i.invited_user_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`, [request.auth!.userId],
  );
  response.json({ data: result.rows });
});

router.get("/:crewId", async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  response.json({ data: await crewDetails(crewId) });
});

router.post("/:crewId/invitations", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const { walletAddress } = z.object({ walletAddress: z.string().min(32).max(44) }).parse(request.body);
  let wallet: string;
  try { wallet = new PublicKey(walletAddress).toBase58(); }
  catch { throw new ApiError(400, "invalid_wallet", "A valid Solana wallet address is required."); }
  const owner = await pool.query("SELECT 1 FROM crews WHERE id = $1 AND owner_user_id = $2", [crewId, request.auth!.userId]);
  if (!owner.rowCount) throw new ApiError(403, "crew_lead_required", "Only the crew lead can invite members.");
  const user = await pool.query<{ id: string }>("SELECT id FROM wallet_users WHERE wallet_address = $1", [wallet]);
  if (!user.rows[0]) throw new ApiError(404, "wallet_not_registered", "The invited wallet must sign in to GuildHall before joining a crew.");
  if (user.rows[0].id === request.auth!.userId) throw new ApiError(409, "crew_self_invite", "The crew lead is already a member.");
  const member = await pool.query("SELECT 1 FROM crew_members WHERE crew_id = $1 AND user_id = $2", [crewId, user.rows[0].id]);
  if (member.rowCount) throw new ApiError(409, "crew_member_exists", "This wallet is already a crew member.");
  const invitation = await pool.query<{ id: string; status: string }>(
    `INSERT INTO crew_invitations (crew_id, invited_user_id) VALUES ($1, $2)
     ON CONFLICT (crew_id, invited_user_id) DO UPDATE SET status = 'pending', created_at = now(), accepted_at = NULL
     WHERE crew_invitations.status = 'revoked'
     RETURNING id, status`, [crewId, user.rows[0].id],
  );
  if (!invitation.rows[0]) throw new ApiError(409, "crew_invitation_exists", "A pending or accepted invitation already exists.");
  response.status(201).json({ data: invitation.rows[0] });
});

router.post("/:crewId/invitations/:invitationId/accept", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const invitationId = uuid.parse(request.params.invitationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invitation = await client.query<{ invited_user_id: string; status: string }>(
      "SELECT invited_user_id, status FROM crew_invitations WHERE id = $1 AND crew_id = $2 FOR UPDATE", [invitationId, crewId],
    );
    if (!invitation.rows[0]) throw new ApiError(404, "crew_invitation_not_found", "Crew invitation not found.");
    if (invitation.rows[0].invited_user_id !== request.auth!.userId) throw new ApiError(403, "crew_invitation_forbidden", "This invitation belongs to another wallet.");
    if (invitation.rows[0].status !== "pending") throw new ApiError(409, "crew_invitation_closed", "This invitation is no longer pending.");
    await client.query("INSERT INTO crew_members (crew_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [crewId, request.auth!.userId]);
    await client.query("UPDATE crew_invitations SET status = 'accepted', accepted_at = now() WHERE id = $1", [invitationId]);
    await client.query("COMMIT");
    response.json({ data: { crewId, invitationId, joined: true } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.post("/:crewId/commissions", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const input = z.object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(20_000),
    asset: z.enum(["USDC", "USDT"]),
    amount: amountInput,
    category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    slaHours: z.number().int().min(1).max(8760).optional(),
    deadlineAt: z.coerce.date(),
    safetyAttestation: taskSafetyAttestation,
    contributors: z.array(z.object({ walletAddress: z.string().min(32).max(44), shareBps: z.number().int().min(1).max(10000), tasks: z.array(taskInput).min(1).max(10) })).min(1).max(20),
  }).parse(request.body);
  assertSafeTaskText(input.title, input.description);
  for (const contributor of input.contributors) for (const task of contributor.tasks) assertSafeTaskText(task.title, task.description);
  if (input.deadlineAt.getTime() <= Date.now() + 60_000) throw new ApiError(400, "invalid_deadline", "The deadline must be at least one minute in the future.");
  if (input.contributors.reduce((sum, member) => sum + member.shareBps, 0) !== 10_000) throw new ApiError(400, "crew_share_total_invalid", "Crew payout shares must add up to 10,000 basis points.");
  const wallets = input.contributors.map((member) => {
    try { return new PublicKey(member.walletAddress).toBase58(); }
    catch { throw new ApiError(400, "invalid_wallet", "Every crew contributor wallet must be a valid Solana address."); }
  });
  if (new Set(wallets).size !== wallets.length) throw new ApiError(400, "duplicate_contributor", "Each crew contributor can appear only once.");
  const amountAtomic = atomic(input.amount);
  const workerNet = BigInt(amountAtomic) - BigInt(amountAtomic) * 200n / 10_000n;
  if (input.contributors.some((contributor) => workerNet * BigInt(contributor.shareBps) / 10_000n < 1n
    || (workerNet / 2n) * BigInt(contributor.shareBps) / 10_000n < 1n)) {
    throw new ApiError(400, "crew_amount_too_small", "The commission must be large enough to pay every contributor, including after an even Tribunal split.");
  }
  const mint = mintFor(input.asset);
  const idempotencyKey = request.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key between 8 and 128 characters.");
  const requestHash = createHash("sha256").update(JSON.stringify({ crewId, ...input, wallets, mint, amountAtomic })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`crew:${crewId}`, idempotencyKey]);
    const crew = await client.query<{ owner_user_id: string; wallet_address: string }>(
      `SELECT c.owner_user_id, u.wallet_address FROM crews c JOIN wallet_users u ON u.id = c.owner_user_id
        WHERE c.id = $1 FOR UPDATE OF c`, [crewId],
    );
    if (!crew.rows[0]) throw new ApiError(404, "crew_not_found", "Crew not found.");
    if (crew.rows[0].owner_user_id === request.auth!.userId) throw new ApiError(409, "crew_cannot_self_fund", "The crew lead cannot fund work assigned to their own crew.");
    const clientIsMember = await client.query("SELECT 1 FROM crew_members WHERE crew_id = $1 AND user_id = $2", [crewId, request.auth!.userId]);
    if (clientIsMember.rowCount) throw new ApiError(409, "crew_client_member", "A crew member cannot fund a commission for their own crew.");
    const members = await client.query<{ user_id: string; wallet_address: string }>(
      `SELECT u.id AS user_id, u.wallet_address FROM crew_members m JOIN wallet_users u ON u.id = m.user_id
        WHERE m.crew_id = $1 AND u.wallet_address = ANY($2::text[])`, [crewId, wallets],
    );
    if (members.rows.length !== wallets.length) throw new ApiError(400, "crew_contributor_not_member", "Every contributor must first accept a crew invitation.");
    if (members.rows.some((member) => member.user_id === request.auth!.userId)) throw new ApiError(400, "crew_client_contributor", "The client cannot receive a payout from its own commission.");
    const memberByWallet = new Map(members.rows.map((member) => [member.wallet_address, member.user_id]));
    const leadUserId = crew.rows[0].owner_user_id;
    if (!memberByWallet.has(crew.rows[0].wallet_address)) throw new ApiError(400, "crew_lead_share_missing", "The crew lead must be included as a paid contributor.");
    const scopedKey = `crew:${crewId}:${idempotencyKey}`;
    const existing = await client.query<{ id: string; request_hash: string | null }>(
      "SELECT id, request_hash FROM commissions WHERE client_user_id = $1 AND idempotency_key = $2",
      [request.auth!.userId, scopedKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used for different crew work.");
      await client.query("COMMIT");
      response.status(200).json({ data: { commissionId: existing.rows[0].id, idempotentReplay: true } });
      return;
    }
    const commission = await client.query<{ id: string }>(
      `INSERT INTO commissions
          (client_user_id, client_wallet, provider_user_id, provider_wallet, title, description, asset_mint,
          amount_atomic, status, deadline_at, accepted_at, idempotency_key, request_hash,
          work_type, work_category, sla_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, NULL, $10, $11, 'crew', $12, $13)
       RETURNING id`,
      [request.auth!.userId, request.auth!.walletAddress, leadUserId, crew.rows[0].wallet_address,
        input.title, input.description, mint, amountAtomic, input.deadlineAt, scopedKey, requestHash,
        input.category, input.slaHours ?? null],
    );
    const commissionId = commission.rows[0].id;
    await client.query("INSERT INTO crew_commissions (commission_id, crew_id, lead_user_id) VALUES ($1, $2, $3)", [commissionId, crewId, leadUserId]);
    await createCommissionEscrowWallet(client, commissionId);
    let order = 0;
    for (const contributor of input.contributors) {
      const contributorWallet = wallets[input.contributors.indexOf(contributor)]!;
      const userId = memberByWallet.get(contributorWallet);
      if (!userId) throw new ApiError(400, "crew_contributor_not_member", "Crew contributor could not be resolved.");
      order += 1;
      await client.query(
        "INSERT INTO commission_payout_shares (commission_id, user_id, wallet_address, share_bps, payout_order) VALUES ($1, $2, $3, $4, $5)",
        [commissionId, userId, contributorWallet, contributor.shareBps, order],
      );
      for (const task of contributor.tasks) await client.query(
        "INSERT INTO crew_tasks (commission_id, assignee_user_id, title, description) VALUES ($1, $2, $3, $4)",
        [commissionId, userId, task.title, task.description],
      );
    }
    await client.query("COMMIT");
    response.status(201).json({ data: { commissionId, crewId, status: "open", escrow: "created", contributorCount: input.contributors.length, idempotentReplay: false } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.get("/:crewId/commissions/:commissionId/tasks", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const commissionId = uuid.parse(request.params.commissionId);
  const membership = await pool.query("SELECT 1 FROM crew_members WHERE crew_id = $1 AND user_id = $2", [crewId, request.auth!.userId]);
  if (!membership.rowCount) throw new ApiError(403, "crew_member_required", "Only crew members can read sub-tasks.");
  const taskRows = await pool.query<{
    id: string; assignee_user_id: string; assignee_wallet: string; title: string; description: string; status: string;
    submitted_at: Date | null; reviewed_at: Date | null; review_rationale: string | null; encrypted_payload: Buffer | null;
    encryption_nonce: Buffer | null; encryption_auth_tag: Buffer | null; encryption_key_version: number | null;
  }>(
    `SELECT t.*, u.wallet_address AS assignee_wallet FROM crew_tasks t
       JOIN crew_commissions cc ON cc.commission_id = t.commission_id
       JOIN wallet_users u ON u.id = t.assignee_user_id
      WHERE t.commission_id = $1 AND cc.crew_id = $2 ORDER BY t.created_at`, [commissionId, crewId],
  );
  response.json({ data: taskRows.rows.map((row) => {
    const { encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version, ...task } = row;
    return { ...task, submission: encrypted_payload && encryption_nonce && encryption_auth_tag && encryption_key_version
      ? decryptPrivateData({ ciphertext: encrypted_payload, nonce: encryption_nonce, authTag: encryption_auth_tag, keyVersion: encryption_key_version }) : null };
  }) });
});

router.post("/:crewId/commissions/:commissionId/tasks/:taskId/submission", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const commissionId = uuid.parse(request.params.commissionId);
  const taskId = uuid.parse(request.params.taskId);
  const input = z.object({ summary: z.string().trim().min(1).max(5000), evidence: z.array(z.object({ kind: z.enum(["url", "text", "hash"]), label: z.string().trim().min(1).max(160), value: z.string().trim().min(1).max(4000) })).min(1).max(30) }).parse(request.body);
  const task = await pool.query<{ assignee_user_id: string; status: string; commission_status: string; accepted_at: Date | null; deadline_at: Date }>(
    `SELECT t.assignee_user_id, t.status, c.status AS commission_status, c.accepted_at, c.deadline_at FROM crew_tasks t
       JOIN crew_commissions cc ON cc.commission_id = t.commission_id JOIN commissions c ON c.id = t.commission_id
      WHERE t.id = $1 AND t.commission_id = $2 AND cc.crew_id = $3`, [taskId, commissionId, crewId],
  );
  if (!task.rows[0]) throw new ApiError(404, "crew_task_not_found", "Crew sub-task not found.");
  if (task.rows[0].assignee_user_id !== request.auth!.userId) throw new ApiError(403, "crew_task_forbidden", "Only the assigned member can submit this sub-task.");
  if (!task.rows[0].commission_status || !["funded", "submitted"].includes(task.rows[0].commission_status)) throw new ApiError(409, "crew_commission_not_funded", "The parent commission must be funded before sub-task delivery.");
  if (!task.rows[0].accepted_at) throw new ApiError(409, "crew_lead_not_accepted", "The crew lead must accept the parent commission before sub-task delivery.");
  if (task.rows[0].deadline_at <= new Date()) throw new ApiError(409, "crew_commission_expired", "The parent commission deadline has passed; late sub-task submissions are closed.");
  if (!["assigned", "changes_requested"].includes(task.rows[0].status)) throw new ApiError(409, "crew_task_not_submittable", "This sub-task is already submitted or accepted.");
  const encrypted = encryptPrivateData(input);
  const result = await pool.query(
    `UPDATE crew_tasks SET status = 'submitted', encrypted_payload = $2, encryption_nonce = $3,
       encryption_auth_tag = $4, encryption_key_version = $5, submitted_at = now(), reviewed_at = NULL,
       review_rationale = NULL, updated_at = now() WHERE id = $1 RETURNING id, status, submitted_at`,
    [taskId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
  );
  response.status(201).json({ data: result.rows[0] });
});

router.post("/:crewId/commissions/:commissionId/tasks/:taskId/review", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const commissionId = uuid.parse(request.params.commissionId);
  const taskId = uuid.parse(request.params.taskId);
  const input = z.object({ decision: z.enum(["accept", "request_changes"]), rationale: z.string().trim().min(1).max(5000) }).parse(request.body);
  const lead = await pool.query("SELECT 1 FROM crew_commissions WHERE commission_id = $1 AND crew_id = $2 AND lead_user_id = $3", [commissionId, crewId, request.auth!.userId]);
  if (!lead.rowCount) throw new ApiError(403, "crew_lead_required", "Only the crew lead can review sub-task delivery.");
  const result = await pool.query<{ id: string }>(
    `UPDATE crew_tasks SET status = $4, reviewed_at = now(), review_rationale = $5, updated_at = now()
      WHERE id = $1 AND commission_id = $2 AND status = 'submitted'
      AND EXISTS (SELECT 1 FROM crew_commissions WHERE commission_id = $2 AND crew_id = $3)
      RETURNING id`,
    [taskId, commissionId, crewId, input.decision === "accept" ? "accepted" : "changes_requested", input.rationale],
  );
  if (!result.rowCount) throw new ApiError(409, "crew_task_not_reviewable", "This sub-task has no submission awaiting review.");
  response.json({ data: { taskId, ...input } });
});

router.get("/:crewId/commissions/:commissionId/payout-shares", requireAuth, async (request, response) => {
  const crewId = uuid.parse(request.params.crewId);
  const commissionId = uuid.parse(request.params.commissionId);
  const member = await pool.query("SELECT 1 FROM crew_members WHERE crew_id = $1 AND user_id = $2", [crewId, request.auth!.userId]);
  if (!member.rowCount) throw new ApiError(403, "crew_member_required", "Only crew members can read the fixed payout shares.");
  const result = await pool.query(
    `SELECT u.wallet_address, s.share_bps, s.payout_order FROM commission_payout_shares s
       JOIN crew_commissions cc ON cc.commission_id = s.commission_id JOIN wallet_users u ON u.id = s.user_id
      WHERE s.commission_id = $1 AND cc.crew_id = $2 ORDER BY s.payout_order`, [commissionId, crewId],
  );
  response.json({ data: result.rows });
});

export { router as crewsRouter };
