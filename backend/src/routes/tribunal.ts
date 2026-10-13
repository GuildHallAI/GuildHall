import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { ApiError } from "../http.js";
import { finalizeBenchIfComplete, runBenchAiVotes } from "../tribunal.js";
import { evaluatorHasCapacity } from "../ghall.js";
import { confirmTribunalAppealFee, markTribunalAppealSubmitted, prepareTribunalAppealFee } from "../tribunal-appeal-fees.js";

export const tribunalRouter = Router();
const uuidSchema = z.string().uuid();
const verdictSchema = z.enum(["client", "provider", "split", "dismissed"]);

tribunalRouter.get("/precedents", async (request, response) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() }).parse(request.query);
  const result = await pool.query(
    `SELECT tc.precedent_ref, c.work_category, c.sla_hours, tc.outcome,
            tc.warden_verdict, tc.panel_verdict, tc.created_at, tc.decided_at,
            (tc.precedent_client_consent_at IS NOT NULL AND tc.precedent_provider_consent_at IS NOT NULL) AS details_public,
            CASE WHEN tc.precedent_client_consent_at IS NOT NULL AND tc.precedent_provider_consent_at IS NOT NULL
              THEN jsonb_build_object(
                'reason', tc.reason, 'evidence', tc.evidence, 'appealRationale', tc.appeal_rationale,
                'decisionSummary', tc.decision_summary,
                'votes', COALESCE((SELECT jsonb_agg(jsonb_build_object('tier', v.tier, 'verdict', v.verdict,
                    'rationale', v.rationale, 'createdAt', v.created_at) ORDER BY v.created_at)
                  FROM tribunal_votes v WHERE v.case_id = tc.id), '[]'::jsonb),
                'aiVotes', COALESCE((SELECT jsonb_agg(jsonb_build_object('modelId', av.model_id, 'verdict', av.verdict,
                    'rationale', av.rationale, 'responseHash', av.response_hash, 'createdAt', av.created_at)
                    ORDER BY av.created_at) FROM tribunal_ai_votes av WHERE av.case_id = tc.id), '[]'::jsonb)
              ) ELSE NULL END AS details
       FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
      WHERE tc.stage = 'decided' AND ($1::timestamptz IS NULL OR tc.decided_at < $1)
      ORDER BY tc.decided_at DESC, tc.precedent_ref DESC LIMIT $2`, [query.before ?? null, query.limit],
  );
  response.json({ data: result.rows, nextBefore: result.rows.length === query.limit
    ? result.rows[result.rows.length - 1]?.decided_at ?? null : null });
});

tribunalRouter.post("/cases/:caseId/precedent-consent", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const { publishDetails } = z.object({ publishDetails: z.boolean() }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query<{ client_user_id: string; provider_user_id: string | null; stage: string }>(
      `SELECT c.client_user_id, c.provider_user_id, tc.stage
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
        WHERE tc.id = $1 FOR UPDATE OF tc`, [caseId],
    );
    const row = item.rows[0];
    if (!row) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
    if (![row.client_user_id, row.provider_user_id].includes(request.auth!.userId)) {
      throw new ApiError(403, "precedent_consent_forbidden", "Only the commission client and provider can consent to publish case details.");
    }
    if (row.stage !== "decided") throw new ApiError(409, "tribunal_case_not_decided", "Precedent publication can be configured after a final ruling.");
    const side = request.auth!.userId === row.client_user_id ? "precedent_client_consent_at" : "precedent_provider_consent_at";
    await client.query(`UPDATE tribunal_cases SET ${side} = $2, updated_at = now() WHERE id = $1`, [caseId, publishDetails ? new Date() : null]);
    const consents = await client.query<{ both_consented: boolean }>(
      "SELECT precedent_client_consent_at IS NOT NULL AND precedent_provider_consent_at IS NOT NULL AS both_consented FROM tribunal_cases WHERE id = $1", [caseId],
    );
    await client.query("COMMIT");
    response.json({ data: { caseId, publishDetails, bothPartiesConsented: consents.rows[0].both_consented } });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

async function visibleCase(caseId: string, userId: string) {
  const result = await pool.query<{
    id: string; commission_id: string; client_user_id: string; provider_user_id: string | null;
    amount_atomic: string; stage: string; warden_user_id: string | null;
    warden_verdict: string | null; panel_verdict: string | null;
    appeal_deadline_at: Date | null; appealed_by: string | null;
  }>(
    `SELECT tc.id, tc.commission_id, tc.stage, tc.warden_user_id, tc.warden_verdict,
            tc.panel_verdict, tc.appeal_deadline_at, tc.appealed_by,
            c.client_user_id, c.provider_user_id, c.amount_atomic
       FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id WHERE tc.id = $1`, [caseId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
  const assigned = await pool.query(
    "SELECT 1 FROM tribunal_assignments WHERE case_id = $1 AND user_id = $2", [caseId, userId],
  );
  if (![row.client_user_id, row.provider_user_id].includes(userId) && !assigned.rowCount) {
    throw new ApiError(403, "tribunal_case_forbidden", "Only commission participants and assigned Tribunal members can access this case.");
  }
  return row;
}

tribunalRouter.get("/cases/:caseId", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  await visibleCase(caseId, request.auth!.userId);
  const result = await pool.query(
    `SELECT tc.id, tc.commission_id, tc.reason, tc.evidence, tc.stage, tc.outcome,
            tc.warden_verdict, tc.panel_verdict, tc.decision_summary, tc.appealed_by,
            tc.appeal_rationale, tc.appeal_deadline_at, tc.created_at, tc.updated_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('tier', v.tier, 'verdict', v.verdict, 'rationale', v.rationale, 'createdAt', v.created_at)
                        ORDER BY v.created_at)
                       FROM tribunal_votes v WHERE v.case_id = tc.id), '[]'::jsonb) AS votes,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('modelId', av.model_id, 'verdict', av.verdict,
                             'rationale', av.rationale, 'responseHash', av.response_hash, 'createdAt', av.created_at)
                         ORDER BY av.created_at)
                       FROM tribunal_ai_votes av WHERE av.case_id = tc.id), '[]'::jsonb) AS ai_votes
       FROM tribunal_cases tc WHERE tc.id = $1`, [caseId],
  );
  response.json({ data: result.rows[0] });
});

tribunalRouter.post("/cases/:caseId/warden-vote", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const input = z.object({ verdict: verdictSchema, rationale: z.string().trim().min(1).max(10000) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const item = await client.query<{
      stage: string; warden_user_id: string | null; amount_atomic: string;
    }>(
      `SELECT tc.stage, tc.warden_user_id, c.amount_atomic
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
        WHERE tc.id = $1 FOR UPDATE OF tc`, [caseId],
    );
    const row = item.rows[0];
    if (!row) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
    if (row.stage !== "warden" || row.warden_user_id !== request.auth!.userId) throw new ApiError(403, "warden_not_assigned", "Only the assigned Warden can rule at this stage.");
    const evaluator = await client.query<{ active: boolean; stake_atomic: string; wallet_address: string }>(
      `SELECT e.active, e.stake_atomic::text, u.wallet_address FROM evaluator_profiles e
       JOIN wallet_users u ON u.id = e.user_id WHERE e.user_id = $1`, [request.auth!.userId],
    );
    if (!evaluator.rows[0]?.active || !await evaluatorHasCapacity(evaluator.rows[0].wallet_address, evaluator.rows[0].stake_atomic, row.amount_atomic)) {
      throw new ApiError(409, "evaluator_capacity_exceeded", "The Warden's active USDC stake no longer covers one fifth of this commission.");
    }
    const vote = await client.query(
      `INSERT INTO tribunal_votes (case_id, voter_user_id, tier, verdict, rationale)
       VALUES ($1, $2, 'warden', $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [caseId, request.auth!.userId, input.verdict, input.rationale],
    );
    if (!vote.rowCount) throw new ApiError(409, "vote_already_cast", "The Warden has already ruled on this case.");
    const appealRule = await client.query<{ value: number }>(
      "SELECT value FROM ghall_governance_settings WHERE rule_key = 'warden_appeal_hours'",
    );
    const appealDeadlineHours = appealRule.rows[0]?.value ?? 24;
    await client.query(
      `UPDATE tribunal_cases SET warden_verdict = $2, warden_decided_at = now(),
         appeal_deadline_at = now() + make_interval(hours => $4),
         updated_by = $3, updated_at = now() WHERE id = $1`,
      [caseId, input.verdict, request.auth!.userId, appealDeadlineHours],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { caseId, tier: "warden", ...input, appealDeadlineHours } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

tribunalRouter.post("/cases/:caseId/appeal-fee-instructions", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const row = await visibleCase(caseId, request.auth!.userId);
  if (![row.client_user_id, row.provider_user_id].includes(request.auth!.userId)) {
    throw new ApiError(403, "commission_forbidden", "Only a commission participant can appeal.");
  }
  const tier = row.stage === "warden" ? "warden" : row.stage === "panel" ? "panel" : null;
  const verdict = tier === "warden" ? row.warden_verdict : tier === "panel" ? row.panel_verdict : null;
  if (!tier || !verdict || !row.appeal_deadline_at || row.appeal_deadline_at < new Date()) {
    throw new ApiError(409, "appeal_window_closed", "There is no active appeal window for this case.");
  }
  const data = await prepareTribunalAppealFee({
    caseId, tier, userId: request.auth!.userId, walletAddress: request.auth!.walletAddress, appealedVerdict: verdict,
  });
  response.status(data.state === "awaiting_payment" ? 201 : 200).json({ data });
});

tribunalRouter.post("/cases/:caseId/appeal-fee-confirm", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const { signature } = z.object({ signature: z.string().min(80).max(100) }).parse(request.body);
  const row = await visibleCase(caseId, request.auth!.userId);
  if (![row.client_user_id, row.provider_user_id].includes(request.auth!.userId)) {
    throw new ApiError(403, "commission_forbidden", "Only a commission participant can pay an appeal fee.");
  }
  const tier = row.stage === "warden" ? "warden" : row.stage === "panel" ? "panel" : null;
  if (!tier) throw new ApiError(409, "appeal_window_closed", "There is no open appeal stage for this case.");
  await confirmTribunalAppealFee(caseId, tier, request.auth!.userId, signature);
  response.json({ data: { caseId, tier, state: config.TRIBUNAL_APPEAL_FEE_ATOMIC > 0n ? "paid" : "waived" } });
});

tribunalRouter.post("/cases/:caseId/appeal", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const { rationale, feeSignature } = z.object({
    rationale: z.string().trim().min(1).max(10000), feeSignature: z.string().min(80).max(100).optional(),
  }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const item = await client.query<{
      stage: string; amount_atomic: string; client_user_id: string; provider_user_id: string | null;
      warden_user_id: string | null; appeal_deadline_at: Date | null; warden_verdict: string | null;
      panel_verdict: string | null; panel_decided_at: Date | null;
    }>(
      `SELECT tc.stage, tc.warden_user_id, tc.appeal_deadline_at, tc.warden_verdict,
              tc.panel_verdict, tc.panel_decided_at,
              c.amount_atomic, c.client_user_id, c.provider_user_id
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
        WHERE tc.id = $1 FOR UPDATE OF tc`, [caseId],
    );
    const row = item.rows[0];
    if (!row) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
    if (![row.client_user_id, row.provider_user_id].includes(request.auth!.userId)) throw new ApiError(403, "commission_forbidden", "Only a commission participant can appeal.");
    if (row.stage === "panel") {
      if (!row.panel_verdict || !row.panel_decided_at || !row.appeal_deadline_at || row.appeal_deadline_at < new Date()) {
        throw new ApiError(409, "appeal_window_closed", "The Panel's appeal window is closed or no ruling exists.");
      }
      if (config.TRIBUNAL_AI_JURORS.length < 3) throw new ApiError(503, "bench_ai_unconfigured", "Configure at least three AI jurors before allowing a final Bench appeal.");
      const jurors = await client.query<{ user_id: string }>(
        `SELECT e.user_id FROM vetted_tribunal_jurors e
          WHERE e.active = true AND e.revoked_at IS NULL AND e.user_id <> $1 AND e.user_id IS DISTINCT FROM $2
            AND NOT EXISTS (SELECT 1 FROM tribunal_assignments a WHERE a.case_id = $3 AND a.user_id = e.user_id)
            AND (SELECT count(*) FROM tribunal_assignments a
                  WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
          ORDER BY random() LIMIT 2 FOR UPDATE OF e SKIP LOCKED`,
        [row.client_user_id, row.provider_user_id, caseId],
      );
      if (jurors.rows.length !== 2) throw new ApiError(503, "bench_humans_unavailable", "Two vetted human jurors are not available for the final Bench.");
      await confirmTribunalAppealFee(caseId, "panel", request.auth!.userId, feeSignature);
      await markTribunalAppealSubmitted(client, caseId, "panel", request.auth!.userId);
      for (const juror of jurors.rows) {
        await client.query(
          "INSERT INTO tribunal_assignments (case_id, user_id, tier, assignment_reason) VALUES ($1, $2, 'bench_juror', 'vetted_human')",
          [caseId, juror.user_id],
        );
      }
      await client.query(
        `UPDATE tribunal_cases SET stage = 'bench', appealed_by = $2, appeal_rationale = $3,
           appeal_deadline_at = NULL, panel_vote_deadline_at = NULL, updated_at = now() WHERE id = $1`, [caseId, request.auth!.userId, rationale],
      );
      await client.query("COMMIT");
      const ai = await runBenchAiVotes(caseId);
      response.status(201).json({ data: { caseId, stage: "bench", humanJurors: 2, aiJurors: ai } });
      return;
    }
    if (row.stage !== "warden" || !row.warden_verdict || row.appeal_deadline_at === null || row.appeal_deadline_at < new Date()) {
      throw new ApiError(409, "appeal_window_closed", "The Warden's appeal window is closed or no ruling exists.");
    }
    if (!config.USDC_MINT) throw new ApiError(503, "stake_asset_unavailable", "USDC stake mint is not configured.");
    const candidates = await client.query<{ user_id: string; wallet_address: string; stake_atomic: string }>(
      `SELECT e.user_id, u.wallet_address, e.stake_atomic::text FROM evaluator_profiles e
         JOIN wallet_users u ON u.id = e.user_id
        WHERE e.active = true AND e.stake_mint = $1
          AND e.stake_atomic * $2::numeric >= $3::numeric * 5 * 10000
          AND e.user_id <> $4 AND e.user_id IS DISTINCT FROM $5 AND e.user_id <> $6
          AND (SELECT count(*) FROM tribunal_assignments a
                WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
        ORDER BY random() LIMIT 50 FOR UPDATE OF e SKIP LOCKED`,
      [config.USDC_MINT, config.GHALL_EVALUATOR_MAX_CAPACITY_BPS, row.amount_atomic, row.client_user_id, row.provider_user_id, row.warden_user_id],
    );
    const eligible = [] as typeof candidates.rows;
    for (const candidate of candidates.rows) {
      if (await evaluatorHasCapacity(candidate.wallet_address, candidate.stake_atomic, row.amount_atomic)) eligible.push(candidate);
      if (eligible.length === 5) break;
    }
    if (eligible.length !== 5) throw new ApiError(503, "panel_unavailable", "Five eligible staked evaluators are not available for this appeal yet.");
    await confirmTribunalAppealFee(caseId, "warden", request.auth!.userId, feeSignature);
    await markTribunalAppealSubmitted(client, caseId, "warden", request.auth!.userId);
    for (const candidate of eligible) {
      await client.query(
        "INSERT INTO tribunal_assignments (case_id, user_id, tier) VALUES ($1, $2, 'panel')",
        [caseId, candidate.user_id],
      );
    }
    await client.query(
      `UPDATE tribunal_assignments SET released_at = now()
       WHERE case_id = $1 AND tier = 'warden' AND released_at IS NULL`, [caseId],
    );
    await client.query(
      `UPDATE tribunal_cases SET stage = 'panel', appealed_by = $2, warden_appealed_at = now(), appeal_deadline_at = NULL,
         panel_vote_deadline_at = now() + make_interval(hours => $4),
         appeal_rationale = $3, updated_by = $2, updated_at = now() WHERE id = $1`,
      [caseId, request.auth!.userId, rationale, config.TRIBUNAL_PANEL_VOTE_HOURS],
    );
    await client.query("COMMIT");
    response.status(201).json({ data: { caseId, stage: "panel", panelSize: 5 } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

tribunalRouter.post("/cases/:caseId/panel-vote", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const input = z.object({ verdict: verdictSchema, rationale: z.string().trim().min(1).max(10000) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const item = await client.query<{ stage: string; amount_atomic: string; commission_id: string; panel_vote_deadline_at: Date | null }>(
      `SELECT tc.stage, tc.panel_vote_deadline_at, c.amount_atomic, c.id AS commission_id
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
        WHERE tc.id = $1 FOR UPDATE OF tc`, [caseId],
    );
    const row = item.rows[0];
    if (!row) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
    if (row.stage !== "panel") throw new ApiError(409, "panel_not_active", "This case is not accepting Panel votes.");
    if (!row.panel_vote_deadline_at || row.panel_vote_deadline_at <= new Date()) {
      throw new ApiError(409, "panel_vote_window_expired", "The Panel voting window has expired; the case is being reassigned.");
    }
    const assignment = await client.query<{ wallet_address: string; stake_atomic: string }>(
      `SELECT u.wallet_address, e.stake_atomic::text FROM tribunal_assignments a JOIN evaluator_profiles e ON e.user_id = a.user_id
        JOIN wallet_users u ON u.id = e.user_id
        WHERE a.case_id = $1 AND a.user_id = $2 AND a.tier = 'panel' AND a.released_at IS NULL
          AND e.active = true`,
      [caseId, request.auth!.userId],
    );
    const eligible = assignment.rows[0] && await evaluatorHasCapacity(assignment.rows[0].wallet_address, assignment.rows[0].stake_atomic, row.amount_atomic);
    if (!eligible) throw new ApiError(403, "panel_not_assigned", "Only an assigned, eligible Panel member can vote.");
    const vote = await client.query(
      `INSERT INTO tribunal_votes (case_id, voter_user_id, tier, verdict, rationale)
       VALUES ($1, $2, 'panel', $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [caseId, request.auth!.userId, input.verdict, input.rationale],
    );
    if (!vote.rowCount) throw new ApiError(409, "vote_already_cast", "This evaluator has already voted on the Panel.");
    const votes = await client.query<{ verdict: string; count: number }>(
      "SELECT verdict, count(*)::int AS count FROM tribunal_votes WHERE case_id = $1 AND tier = 'panel' GROUP BY verdict ORDER BY count DESC",
      [caseId],
    );
    const total = votes.rows.reduce((sum, result) => sum + result.count, 0);
    let panelVerdict: string | null = null;
    if (total === 5) {
      const highest = votes.rows[0].count;
      const leaders = votes.rows.filter((result) => result.count === highest);
      panelVerdict = leaders.length === 1 ? leaders[0].verdict : "split";
      const appealRule = await client.query<{ value: number }>(
        "SELECT value FROM ghall_governance_settings WHERE rule_key = 'panel_appeal_hours'",
      );
      const appealDeadlineHours = appealRule.rows[0]?.value ?? 24;
      await client.query(
        `UPDATE tribunal_cases SET panel_verdict = $2, panel_decided_at = now(), panel_vote_deadline_at = NULL,
           appeal_deadline_at = now() + make_interval(hours => $4), updated_by = $3, updated_at = now()
         WHERE id = $1`, [caseId, panelVerdict, request.auth!.userId, appealDeadlineHours],
      );
      await client.query(
        "UPDATE tribunal_assignments SET released_at = now() WHERE case_id = $1 AND tier = 'panel' AND released_at IS NULL",
        [caseId],
      );
    }
    await client.query("COMMIT");
    response.status(201).json({ data: { caseId, tier: "panel", votesReceived: total, votesRequired: 5, panelVerdict } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

tribunalRouter.post("/cases/:caseId/bench-vote", requireAuth, async (request, response) => {
  const caseId = uuidSchema.parse(request.params.caseId);
  const input = z.object({ verdict: verdictSchema, rationale: z.string().trim().min(1).max(10000) }).parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const current = await client.query<{ stage: string }>(
      "SELECT stage FROM tribunal_cases WHERE id = $1 FOR UPDATE", [caseId],
    );
    if (!current.rows[0]) throw new ApiError(404, "tribunal_case_not_found", "Tribunal case not found.");
    if (current.rows[0].stage !== "bench") throw new ApiError(409, "bench_not_active", "This case is not accepting final Bench votes.");
    const assignment = await client.query(
      `SELECT 1 FROM tribunal_assignments a JOIN vetted_tribunal_jurors e ON e.user_id = a.user_id
        WHERE a.case_id = $1 AND a.user_id = $2 AND a.tier = 'bench_juror'
          AND a.released_at IS NULL AND e.active = true AND e.revoked_at IS NULL`,
      [caseId, request.auth!.userId],
    );
    if (!assignment.rowCount) throw new ApiError(403, "bench_juror_not_assigned", "Only one of the assigned vetted human jurors can vote.");
    const vote = await client.query(
      `INSERT INTO tribunal_votes (case_id, voter_user_id, tier, verdict, rationale)
       VALUES ($1, $2, 'bench_juror', $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [caseId, request.auth!.userId, input.verdict, input.rationale],
    );
    if (!vote.rowCount) throw new ApiError(409, "vote_already_cast", "This juror has already voted on the final Bench.");
    await client.query(
      "UPDATE tribunal_assignments SET released_at = now() WHERE case_id = $1 AND user_id = $2 AND tier = 'bench_juror'",
      [caseId, request.auth!.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const decided = await finalizeBenchIfComplete(caseId);
  response.status(201).json({ data: { caseId, tier: "bench_juror", ...input, decided } });
});
