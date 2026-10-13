import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { config } from "../config.js";
import { reconcileCommissionSettlements, settleDecidedTribunalCases } from "../escrow-settlement.js";
import { assignUnassignedWardens, finalizeExpiredTribunalRulings, reassignStalePanelMembers, runPendingBenchAiVotes } from "../tribunal.js";
import { reconcileOverturnedWardens } from "../evaluator-slashing.js";
import { reconcileEvaluatorStakeWithdrawals } from "../evaluator-staking.js";
import { reconcileAgentTransfers } from "../agent-accounts.js";
import { reconcileAgentX402Requests } from "./agent-accounts.js";
import { reconcileBountyXPosts } from "../bounty-x.js";
import { reconcileXBountyCommands } from "../bounty-x-intake.js";
import { reconcileBountyBondReturns } from "../bounty-bonds.js";
import { reassignStaleBountyEvaluators } from "../bounty-evaluators.js";
import { reconcileGuildBondReturns } from "../guild-bond-returns.js";
import { reconcileWorkRecordChainOperations } from "../onchain-work-records.js";
import { reconcileSuretyPool } from "../surety-pool.js";
import { reconcileCharterBuybacks, reconcileCharterLaunches, reconcileCharterTokenOperations, reconcileCharterTransferFees } from "./charters.js";
import { reconcileProvingGround, reconcileProvingGroundFundings } from "./proving-ground.js";
import { reconcileProvingGroundFundedTrades } from "./proving-ground-funded.js";
import { refreshRateBoardSnapshot } from "./rate-board.js";
import { reconcileGhallProposals, reconcileGhallStakeWithdrawals } from "./ghall.js";
import { reconcileTribunalAppealFees } from "../tribunal-appeal-fees.js";

export const internalRouter = Router();

function requireCronSecret(supplied: string) {
  const expected = config.CRON_SECRET;
  if (expected.length < 32) throw new ApiError(503, "internal_api_unavailable", "The internal API secret must be configured with at least 32 characters.");
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new ApiError(401, "invalid_cron_secret", "A valid internal API secret is required.");
  }
}

async function runReconcileTask<T>(name: string, task: () => Promise<T>): Promise<T | { error: "reconcile_failed" }> {
  try {
    return await task();
  } catch (error) {
    // Keep a single worker failure from preventing the remaining durable queues from progressing.
    console.error(`[reconcile:${name}]`, error);
    return { error: "reconcile_failed" };
  }
}

export async function reconcileOnce(limit = 25) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('guildhall-global-reconciler')) AS acquired",
    );
    if (!lock.rows[0]?.acquired) return { skipped: true as const, reason: "already_running" as const };
    locked = true;
    const wardens = await runReconcileTask("wardens", () => assignUnassignedWardens(limit));
    const panelReassignments = await runReconcileTask("panel-reassignments", () => reassignStalePanelMembers(limit));
    const benchVotes = await runReconcileTask("bench-votes", () => runPendingBenchAiVotes(Math.min(limit, 5)));
    const rulings = await runReconcileTask("rulings", () => finalizeExpiredTribunalRulings(limit));
    const slashes = await runReconcileTask("slashes", () => reconcileOverturnedWardens(limit));
    const stakeWithdrawals = await runReconcileTask("stake-withdrawals", () => reconcileEvaluatorStakeWithdrawals(limit));
    const agentTransfers = await runReconcileTask("agent-transfers", () => reconcileAgentTransfers(limit));
    const agentX402Requests = await runReconcileTask("agent-x402-requests", () => reconcileAgentX402Requests(limit));
    const tribunalSettlements = await runReconcileTask("tribunal-settlements", () => settleDecidedTribunalCases(limit));
    const pendingSettlements = await runReconcileTask("commission-settlements", () => reconcileCommissionSettlements(limit));
    const bountyEvaluators = await runReconcileTask("bounty-evaluators", () => reassignStaleBountyEvaluators(limit));
    const bountyBonds = await runReconcileTask("bounty-bonds", () => reconcileBountyBondReturns(limit));
    const bountyXPosts = await runReconcileTask("bounty-x-posts", () => reconcileBountyXPosts(limit));
    const bountyXCommands = await runReconcileTask("bounty-x-commands", () => reconcileXBountyCommands(limit));
    const guildBondReturns = await runReconcileTask("guild-bond-returns", () => reconcileGuildBondReturns(limit));
    const onchainWorkRecords = await runReconcileTask("work-records", () => reconcileWorkRecordChainOperations(limit));
    const surety = await runReconcileTask("surety", () => reconcileSuretyPool(limit));
    const charterLaunches = await runReconcileTask("charter-launches", () => reconcileCharterLaunches(limit));
    const charterTokenOperations = await runReconcileTask("charter-token-operations", () => reconcileCharterTokenOperations(limit));
    const charterTransferFees = await runReconcileTask("charter-transfer-fees", () => reconcileCharterTransferFees(limit));
    const charterBuybacks = await runReconcileTask("charter-buybacks", () => reconcileCharterBuybacks(limit));
    const provingGround = await runReconcileTask("proving-ground", () => reconcileProvingGround(limit));
    const provingGroundFundings = await runReconcileTask("proving-ground-fundings", () => reconcileProvingGroundFundings(limit));
    const provingGroundFundedTrades = await runReconcileTask("proving-ground-funded-trades", () => reconcileProvingGroundFundedTrades(limit));
    const rateBoard = await runReconcileTask("rate-board", refreshRateBoardSnapshot);
    const ghallProposals = await runReconcileTask("ghall-proposals", () => reconcileGhallProposals(limit));
    const ghallStakeWithdrawals = await runReconcileTask("ghall-stake-withdrawals", () => reconcileGhallStakeWithdrawals(limit));
    const appealFees = await runReconcileTask("tribunal-appeal-fees", () => reconcileTribunalAppealFees(limit));
    return { skipped: false as const, wardens, panelReassignments, benchVotes, rulings, slashes, stakeWithdrawals, agentTransfers, agentX402Requests, tribunalSettlements, pendingSettlements, bountyEvaluators, bountyBonds, bountyXPosts, bountyXCommands, guildBondReturns, onchainWorkRecords, surety, charterLaunches, charterTokenOperations, charterTransferFees, charterBuybacks, provingGround, provingGroundFundings, provingGroundFundedTrades, rateBoard, ghallProposals, ghallStakeWithdrawals, appealFees };
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext('guildhall-global-reconciler'))").catch(() => undefined);
    lockClient.release();
  }
}

internalRouter.post("/reconcile", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.body ?? {});
  const result = await reconcileOnce(limit);
  response.json({ data: result });
});

internalRouter.get("/launch-metrics", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const { launchAt } = z.object({ launchAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)) }).parse(request.query);
  const day7End = new Date(launchAt.getTime() + 7 * 86_400_000);
  const day30Start = new Date(launchAt.getTime() + 23 * 86_400_000);
  const day30End = new Date(launchAt.getTime() + 30 * 86_400_000);
  const day45End = new Date(launchAt.getTime() + 45 * 86_400_000);
  const [firstWeek, day30Week, appeals, xBounties, hands, charters, evaluatorDisputes] = await Promise.all([
    pool.query<{ funded: string; escrowed_atomic: string }>(
      `SELECT count(*)::text AS funded, COALESCE(sum(amount_atomic), 0)::text AS escrowed_atomic
         FROM commissions WHERE funded_at >= $1 AND funded_at < $2`, [launchAt, day7End]),
    pool.query<{ funded: string }>(
      `SELECT count(*)::text AS funded FROM commissions WHERE funded_at >= $1 AND funded_at < $2`, [day30Start, day30End]),
    pool.query<{ decided: string; overturned: string }>(
      `SELECT count(*)::text AS decided,
              count(*) FILTER (WHERE warden_verdict IS NOT NULL AND
                (CASE WHEN outcome = 'dismissed' THEN 'provider' ELSE outcome END) <>
                (CASE WHEN warden_verdict = 'dismissed' THEN 'provider' ELSE warden_verdict END))::text AS overturned
         FROM tribunal_cases
        WHERE stage = 'decided' AND appealed_by IS NOT NULL AND created_at >= $1 AND decided_at < $2`, [launchAt, day45End]),
    pool.query<{ funded: string }>(
      `SELECT count(DISTINCT c.id)::text AS funded
         FROM commissions c JOIN x_bounty_commands x ON x.commission_id = c.id
        WHERE c.funded_at >= $1 AND c.funded_at < $2`, [launchAt, day45End]),
    pool.query<{ completed: string }>(
      `SELECT count(DISTINCT c.id)::text AS completed
         FROM commissions c JOIN work_records w ON w.commission_id = c.id
        WHERE c.work_type = 'hand' AND c.status = 'complete' AND w.finalized_at >= $1 AND w.finalized_at < $2`, [launchAt, day45End]),
    pool.query<{ launched: string }>(
      "SELECT count(*)::text AS launched FROM charters WHERE state = 'active' AND launched_at >= $1 AND launched_at < $2", [launchAt, day45End]),
    pool.query<{ wallet_address: string; assigned: string; appealed: string }>(
      `SELECT u.wallet_address,
              count(*)::text AS assigned,
              count(*) FILTER (WHERE tc.warden_appealed_at IS NOT NULL)::text AS appealed
         FROM tribunal_cases tc JOIN evaluator_profiles ep ON ep.user_id = tc.warden_user_id
         JOIN wallet_users u ON u.id = ep.user_id
        WHERE tc.warden_decided_at >= now() - interval '7 days'
          AND (tc.appeal_deadline_at IS NULL OR tc.appeal_deadline_at <= now())
        GROUP BY u.wallet_address ORDER BY u.wallet_address`),
  ]);

  const fundedFirstWeek = Number(firstWeek.rows[0].funded);
  const escrowedAtomic = BigInt(firstWeek.rows[0].escrowed_atomic);
  const fundedWeekAtDay30 = Number(day30Week.rows[0].funded);
  const appealCount = Number(appeals.rows[0].decided);
  const overturnedCount = Number(appeals.rows[0].overturned);
  const overturnRate = appealCount === 0 ? null : overturnedCount / appealCount;
  const day7Due = new Date() >= day7End;
  const day30Due = new Date() >= day30End;
  const day45Due = new Date() >= day45End;
  const evaluatorRates = evaluatorDisputes.rows.map((row) => {
    const assigned = Number(row.assigned);
    const appealed = Number(row.appealed);
    return { walletAddress: row.wallet_address, assignedWardenCases: assigned, appealedCases: appealed,
      disputeRate: assigned === 0 ? null : appealed / assigned,
      aboveThreshold: assigned > 0 && appealed / assigned > 0.15 };
  });
  response.json({ data: {
    launchAt,
    windows: { day7End, day30Start, day30End, day45End, evaluatorDisputeWindowStart: new Date(Date.now() - 7 * 86_400_000) },
    criteria: {
      day7: { due: day7Due, fundedCommissions: fundedFirstWeek, escrowedAtomic: escrowedAtomic.toString(),
        target: { fundedCommissions: 200, escrowedAtomic: "50000000000" },
        met: fundedFirstWeek >= 200 || escrowedAtomic >= 50_000_000_000n },
      day30: { due: day30Due, fundedCommissionsInWeekBeforeDay30: fundedWeekAtDay30,
        target: { fundedCommissionsPerWeek: 1000 }, met: fundedWeekAtDay30 >= 1000 },
      day45: { due: day45Due, decidedAppeals: appealCount, overturnedAppeals: overturnedCount,
        overturnRate, fundedXBounties: Number(xBounties.rows[0].funded), completedHandsTasks: Number(hands.rows[0].completed),
        activeCharters: Number(charters.rows[0].launched),
        targets: { decidedAppeals: 50, overturnRateMin: 0.05, overturnRateMax: 0.4, fundedXBounties: 30, completedHandsTasks: 300, activeCharters: 10 },
        met: appealCount >= 50 && overturnRate !== null && overturnRate >= 0.05 && overturnRate <= 0.4
          && Number(xBounties.rows[0].funded) >= 30 && Number(hands.rows[0].completed) >= 300 && Number(charters.rows[0].launched) >= 10 },
      evaluatorDisputeMonitoring: { windowDays: 7, triggerRate: 0.15, evaluators: evaluatorRates,
        pauseEvaluatorOnboarding: evaluatorRates.some((row) => row.aboveThreshold) },
    },
  } });
});

internalRouter.post("/jurors/:userId/approve", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const userId = z.string().uuid().parse(request.params.userId);
  const { maxConcurrentCases } = z.object({
    maxConcurrentCases: z.coerce.number().int().min(1).max(10).default(2),
  }).parse(request.body ?? {});
  const user = await pool.query("SELECT 1 FROM wallet_users WHERE id = $1", [userId]);
  if (!user.rowCount) throw new ApiError(404, "wallet_user_not_found", "Wallet user not found.");
  await pool.query(
    `INSERT INTO vetted_tribunal_jurors (user_id, active, max_concurrent_cases, vetted_by, revoked_at)
     VALUES ($1, true, $2, 'internal_api', NULL)
     ON CONFLICT (user_id) DO UPDATE SET active = true, max_concurrent_cases = $2,
       vetted_by = 'internal_api', vetted_at = now(), revoked_at = NULL`,
    [userId, maxConcurrentCases],
  );
  response.status(201).json({ data: { userId, active: true, maxConcurrentCases } });
});

internalRouter.post("/jurors/:userId/revoke", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const userId = z.string().uuid().parse(request.params.userId);
  await pool.query(
    "UPDATE vetted_tribunal_jurors SET active = false, revoked_at = now() WHERE user_id = $1", [userId],
  );
  response.json({ data: { userId, active: false } });
});

internalRouter.get("/task-reports", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  const result = await pool.query(
    `SELECT r.id, r.commission_id, r.reporter_wallet, r.reason, r.details, r.created_at,
            c.title, c.description, c.work_type, c.status AS commission_status
       FROM task_reports r JOIN commissions c ON c.id = r.commission_id
      WHERE r.state = 'open' ORDER BY r.created_at, r.id LIMIT $1`, [query.limit],
  );
  response.json({ data: result.rows });
});

internalRouter.post("/task-reports/:reportId/resolve", async (request, response) => {
  requireCronSecret(request.header("x-cron-secret") ?? "");
  const reportId = z.string().uuid().parse(request.params.reportId);
  const input = z.object({
    resolution: z.enum(["action_taken", "no_violation", "needs_followup"]),
    note: z.string().trim().min(1).max(5000),
  }).parse(request.body);
  const result = await pool.query<{ id: string; state: string; resolution: string }>(
    `UPDATE task_reports SET state = 'resolved', resolution = $2, resolution_note = $3,
       resolved_by = 'internal_api', resolved_at = now()
     WHERE id = $1 AND state = 'open' RETURNING id, state, resolution`,
    [reportId, input.resolution, input.note],
  );
  if (!result.rowCount) throw new ApiError(404, "open_task_report_not_found", "No open task report was found with that ID.");
  response.json({ data: result.rows[0] });
});
