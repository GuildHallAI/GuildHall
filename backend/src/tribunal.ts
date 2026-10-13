import { pool } from "./db/index.js";
import { config } from "./config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptPrivateData } from "./private-data.js";
import { evaluatorHasCapacity } from "./ghall.js";
import { queueTribunalAppealFeeSettlements } from "./tribunal-appeal-fees.js";

async function assignWarden(caseId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const dispute = await client.query<{
      stage: string; amount_atomic: string; client_user_id: string; provider_user_id: string | null;
    }>(
      `SELECT tc.stage, c.amount_atomic, c.client_user_id, c.provider_user_id
         FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
        WHERE tc.id = $1 FOR UPDATE OF tc`, [caseId],
    );
    const row = dispute.rows[0];
    if (!row || row.stage !== "unassigned") {
      await client.query("COMMIT");
      return false;
    }
    const candidates = await client.query<{ user_id: string; wallet_address: string; stake_atomic: string }>(
      `SELECT e.user_id, u.wallet_address, e.stake_atomic::text FROM evaluator_profiles e
         JOIN wallet_users u ON u.id = e.user_id
        WHERE e.active = true AND e.stake_atomic * $1::numeric >= $2::numeric * 5 * 10000
          AND e.stake_mint = $3 AND e.user_id <> $4 AND e.user_id IS DISTINCT FROM $5
          AND (SELECT count(*) FROM tribunal_assignments a
                WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
        ORDER BY random() LIMIT 50 FOR UPDATE OF e SKIP LOCKED`,
      [config.GHALL_EVALUATOR_MAX_CAPACITY_BPS, row.amount_atomic, config.USDC_MINT, row.client_user_id, row.provider_user_id],
    );
    let candidate: { user_id: string } | undefined;
    for (const item of candidates.rows) {
      if (await evaluatorHasCapacity(item.wallet_address, item.stake_atomic, row.amount_atomic)) {
        candidate = item;
        break;
      }
    }
    if (!candidate) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "INSERT INTO tribunal_assignments (case_id, user_id, tier) VALUES ($1, $2, 'warden')",
      [caseId, candidate.user_id],
    );
    await client.query(
      `UPDATE tribunal_cases SET stage = 'warden', warden_user_id = $2, updated_at = now()
       WHERE id = $1`, [caseId, candidate.user_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assignUnassignedWardens(limit = 25) {
  const cases = await pool.query<{ id: string }>(
    "SELECT id FROM tribunal_cases WHERE stage = 'unassigned' ORDER BY created_at LIMIT $1", [limit],
  );
  let assigned = 0;
  for (const row of cases.rows) if (await assignWarden(row.id)) assigned += 1;
  return { examined: cases.rows.length, assigned };
}

export async function reassignStalePanelMembers(limit = 25) {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM tribunal_cases
      WHERE stage = 'panel' AND panel_vote_deadline_at <= now()
      ORDER BY panel_vote_deadline_at LIMIT $1`, [limit],
  );
  let reassigned = 0;
  let waiting = 0;
  for (const item of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${item.id}`]);
      const selected = await client.query<{
        stage: string; amount_atomic: string; client_user_id: string; provider_user_id: string | null;
        deadline: Date | null;
      }>(
        `SELECT tc.stage, tc.panel_vote_deadline_at AS deadline, c.amount_atomic,
                c.client_user_id, c.provider_user_id
           FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id
          WHERE tc.id = $1 FOR UPDATE OF tc`, [item.id],
      );
      const row = selected.rows[0];
      if (!row || row.stage !== "panel" || !row.deadline || row.deadline > new Date()) {
        await client.query("COMMIT");
        continue;
      }
      const voteCount = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tribunal_votes WHERE case_id = $1 AND tier = 'panel'", [item.id],
      );
      const vacancies = Math.max(0, 5 - (voteCount.rows[0]?.count ?? 0));
      if (!vacancies) {
        await client.query("UPDATE tribunal_cases SET panel_vote_deadline_at = NULL WHERE id = $1", [item.id]);
        await client.query("COMMIT");
        continue;
      }
      await client.query(
        `UPDATE tribunal_assignments a SET released_at = now()
          WHERE a.case_id = $1 AND a.tier = 'panel' AND a.released_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM tribunal_votes v
                             WHERE v.case_id = a.case_id AND v.voter_user_id = a.user_id AND v.tier = 'panel')`,
        [item.id],
      );
      const candidates = await client.query<{ user_id: string; wallet_address: string; stake_atomic: string }>(
        `SELECT e.user_id, u.wallet_address, e.stake_atomic::text
           FROM evaluator_profiles e JOIN wallet_users u ON u.id = e.user_id
          WHERE e.active = true AND e.stake_mint = $1
            AND e.stake_atomic * $2::numeric >= $3::numeric * 5 * 10000
            AND e.user_id <> $4 AND e.user_id IS DISTINCT FROM $5
            AND NOT EXISTS (SELECT 1 FROM tribunal_assignments a WHERE a.case_id = $6 AND a.user_id = e.user_id)
            AND (SELECT count(*) FROM tribunal_assignments a
                  WHERE a.user_id = e.user_id AND a.released_at IS NULL) < e.max_concurrent_cases
          ORDER BY random() LIMIT 100 FOR UPDATE OF e SKIP LOCKED`,
        [config.USDC_MINT, config.GHALL_EVALUATOR_MAX_CAPACITY_BPS, row.amount_atomic,
          row.client_user_id, row.provider_user_id, item.id],
      );
      const eligible = [] as typeof candidates.rows;
      for (const candidate of candidates.rows) {
        if (await evaluatorHasCapacity(candidate.wallet_address, candidate.stake_atomic, row.amount_atomic)) eligible.push(candidate);
        if (eligible.length === vacancies) break;
      }
      if (eligible.length === vacancies) {
        for (const candidate of eligible) {
          await client.query(
            "INSERT INTO tribunal_assignments (case_id, user_id, tier) VALUES ($1, $2, 'panel')",
            [item.id, candidate.user_id],
          );
        }
        await client.query(
          `UPDATE tribunal_cases SET panel_vote_deadline_at = now() + make_interval(hours => $2), updated_at = now()
            WHERE id = $1`, [item.id, config.TRIBUNAL_PANEL_VOTE_HOURS],
        );
        reassigned += vacancies;
      } else {
        // Keep the case durable and retry soon without giving a partial replacement panel a rushed deadline.
        await client.query(
          `UPDATE tribunal_cases SET panel_vote_deadline_at = now() + interval '1 minute', updated_at = now()
            WHERE id = $1`, [item.id],
        );
        waiting += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { examined: due.rows.length, reassigned, waiting };
}

export async function openTribunalCase(caseId: string) {
  return assignWarden(caseId);
}

export async function finalizeTribunalDecision(caseId: string, verdict: "client" | "provider" | "split" | "dismissed") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tribunal:${caseId}`]);
    const selected = await client.query<{ stage: string; commission_id: string; warden_verdict: string | null; panel_verdict: string | null }>(
      "SELECT stage, commission_id, warden_verdict, panel_verdict FROM tribunal_cases WHERE id = $1 FOR UPDATE", [caseId],
    );
    const row = selected.rows[0];
    if (!row || row.stage === "decided") {
      await client.query("COMMIT");
      return false;
    }
    const commissionStatus = verdict === "client" ? "refund_pending"
      : verdict === "split" ? "split_pending" : "approved";
    await client.query(
      `UPDATE tribunal_cases SET stage = 'decided', outcome = $2, decided_at = now(),
         panel_vote_deadline_at = NULL, updated_at = now()
       WHERE id = $1`, [caseId, verdict],
    );
    await client.query(
      `UPDATE commissions SET status = $2, updated_at = now()
       WHERE id = $1 AND status = 'disputed'`, [row.commission_id, commissionStatus],
    );
    await client.query(
      "UPDATE tribunal_assignments SET released_at = now() WHERE case_id = $1 AND released_at IS NULL", [caseId],
    );
    await queueTribunalAppealFeeSettlements(client, caseId, verdict, row.warden_verdict, row.panel_verdict);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeExpiredTribunalRulings(limit = 25) {
  const due = await pool.query<{ id: string; verdict: "client" | "provider" | "split" | "dismissed" }>(
    `SELECT id,
            CASE WHEN stage = 'warden' THEN warden_verdict ELSE panel_verdict END AS verdict
       FROM tribunal_cases
      WHERE ((stage = 'warden' AND warden_verdict IS NOT NULL AND appeal_deadline_at <= now())
          OR (stage = 'panel' AND panel_verdict IS NOT NULL AND appeal_deadline_at <= now()))
      ORDER BY appeal_deadline_at LIMIT $1`, [limit],
  );
  let finalized = 0;
  for (const row of due.rows) {
    if (row.verdict && await finalizeTribunalDecision(row.id, row.verdict)) finalized += 1;
  }
  return { examined: due.rows.length, finalized };
}

const aiDecision = z.object({
  verdict: z.enum(["client", "provider", "split", "dismissed"]),
  rationale: z.string().min(1).max(10000),
});

export async function runBenchAiVotes(caseId: string) {
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    const locked = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [`tribunal-ai:${caseId}`],
    );
    if (!locked.rows[0]?.acquired) return { configured: config.TRIBUNAL_AI_JURORS.length, required: 3, votes: 0, errors: ["jurors_in_progress"] };
    lockHeld = true;
    return await runBenchAiVotesLocked(caseId);
  } finally {
    if (lockHeld) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`tribunal-ai:${caseId}`]).catch(() => undefined);
    lockClient.release();
  }
}

async function runBenchAiVotesLocked(caseId: string) {
  const models = config.TRIBUNAL_AI_JURORS;
  if (models.length < 3) return { configured: models.length, required: 3, votes: 0, errors: ["jurors_unconfigured"] };
  const contextResult = await pool.query<{
    reason: string; evidence: unknown; title: string; description: string;
    commission_id: string; stage: string; appeal_rationale: string | null;
    warden_verdict: string | null; panel_verdict: string | null;
  }>(
    `SELECT tc.reason, tc.evidence, tc.stage, tc.appeal_rationale, tc.warden_verdict, tc.panel_verdict,
            c.id AS commission_id, c.title, c.description
       FROM tribunal_cases tc JOIN commissions c ON c.id = tc.commission_id WHERE tc.id = $1`, [caseId],
  );
  const context = contextResult.rows[0];
  if (!context || context.stage !== "bench") return { configured: models.length, required: 3, votes: 0, errors: ["bench_not_active"] };
  const submissionRows = await pool.query<{
    revision: number; encrypted_payload: Buffer; encryption_nonce: Buffer;
    encryption_auth_tag: Buffer; encryption_key_version: number;
  }>(
    `SELECT revision, encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version
       FROM commission_submissions WHERE commission_id = $1 ORDER BY revision`, [context.commission_id],
  );
  const submissions = submissionRows.rows.map((row) => ({
    revision: row.revision,
    ...decryptPrivateData<{ summary: string; evidence: unknown[] }>({
      ciphertext: row.encrypted_payload, nonce: row.encryption_nonce, authTag: row.encryption_auth_tag,
      keyVersion: row.encryption_key_version,
    }),
  }));
  const prompt = [
    "You are an independent GuildHall final Tribunal juror.",
    "Consider only the posted commission terms, dispute reason, evidence, and submissions.",
    "Return a JSON object with verdict equal to client, provider, split, or dismissed, and a concise rationale.",
    "Do not infer facts that are not in the record. A split verdict means an even division.",
    JSON.stringify({ title: context.title, description: context.description, reason: context.reason,
      appealRationale: context.appeal_rationale, wardenVerdict: context.warden_verdict,
      panelVerdict: context.panel_verdict, caseEvidence: context.evidence, submissions }),
  ].join("\n\n");
  const results = await Promise.all(models.map(async (juror) => {
    try {
      const response = await fetch(juror.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${juror.apiKey}` },
        body: JSON.stringify({
          model: juror.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return only valid JSON. You are an independent evidence reviewer." },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error("juror_request_failed");
      const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("juror_response_empty");
      const raw = JSON.parse(content) as unknown;
      const decision = aiDecision.parse(raw);
      const digest = createHash("sha256").update(content).digest("hex");
      await pool.query(
        `INSERT INTO tribunal_ai_votes (case_id, model_id, verdict, rationale, response_hash)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (case_id, model_id) DO NOTHING`,
        [caseId, juror.id, decision.verdict, decision.rationale, digest],
      );
      return { id: juror.id, error: null };
    } catch {
      return { id: juror.id, error: "juror_unavailable" };
    }
  }));
  const result = {
    configured: models.length,
    required: 3,
    votes: results.filter((row) => row.error === null).length,
    errors: results.filter((row) => row.error).map((row) => `${row.id}:${row.error}`),
  };
  await finalizeBenchIfComplete(caseId);
  return result;
}

export async function finalizeBenchIfComplete(caseId: string) {
  const jurorCount = config.TRIBUNAL_AI_JURORS.length;
  if (jurorCount < 3) return false;
  const votes = await pool.query<{ verdict: "client" | "provider" | "split" | "dismissed"; count: number }>(
    `SELECT verdict, count(*)::int AS count FROM (
       SELECT verdict FROM tribunal_ai_votes WHERE case_id = $1
       UNION ALL
       SELECT verdict FROM tribunal_votes WHERE case_id = $1 AND tier = 'bench_juror'
     ) all_votes GROUP BY verdict ORDER BY count DESC`, [caseId],
  );
  const total = votes.rows.reduce((sum, vote) => sum + vote.count, 0);
  if (total !== jurorCount + 2) return false;
  const leaders = votes.rows.filter((vote) => vote.count === votes.rows[0].count);
  const verdict = leaders.length === 1 ? leaders[0].verdict : "split";
  return finalizeTribunalDecision(caseId, verdict);
}

export async function runPendingBenchAiVotes(limit = 10) {
  const pending = await pool.query<{ id: string }>(
    `SELECT tc.id FROM tribunal_cases tc
      WHERE tc.stage = 'bench'
        AND (SELECT count(*) FROM tribunal_ai_votes v WHERE v.case_id = tc.id) < $1
      ORDER BY tc.updated_at LIMIT $2`, [config.TRIBUNAL_AI_JURORS.length, limit],
  );
  let completed = 0;
  for (const item of pending.rows) {
    const result = await runBenchAiVotes(item.id);
    if (result.votes >= 3) completed += 1;
  }
  return { examined: pending.rows.length, completed };
}
