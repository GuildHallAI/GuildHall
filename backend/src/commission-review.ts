import { z } from "zod";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";
import { openTribunalCase } from "./tribunal.js";
import { settleCommission } from "./escrow-settlement.js";

export const commissionReviewInputSchema = z.object({
  decision: z.enum(["accept", "request_changes", "dispute"]),
  rationale: z.string().trim().min(1).max(10_000),
});

export async function reviewCommissionSubmission(
  commissionId: string,
  clientUserId: string,
  value: unknown,
) {
  const input = commissionReviewInputSchema.parse(value);
  const client = await pool.connect();
  let tribunalCaseId: string | null = null;
  let submissionId = "";
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [commissionId]);
    const selected = await client.query<{
      id: string; client_user_id: string; status: string; requires_tribunal: boolean;
    }>("SELECT id, client_user_id, status, requires_tribunal FROM commissions WHERE id = $1 FOR UPDATE", [commissionId]);
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.client_user_id !== clientUserId) throw new ApiError(403, "commission_forbidden", "Only the commission client can review this submission.");
    if (commission.status !== "submitted") throw new ApiError(409, "submission_not_reviewable", "This commission has no submission awaiting review.");
    const submissionResult = await client.query<{ id: string }>(
      "SELECT id FROM commission_submissions WHERE commission_id = $1 ORDER BY revision DESC LIMIT 1", [commissionId],
    );
    submissionId = submissionResult.rows[0]?.id ?? "";
    if (!submissionId) throw new ApiError(409, "submission_missing", "No submission was found for this commission.");
    await client.query(
      `INSERT INTO commission_reviews (commission_id, submission_id, reviewer_user_id, decision, rationale)
       VALUES ($1, $2, $3, $4, $5)`,
      [commissionId, submissionId, clientUserId, input.decision, input.rationale],
    );
    const tribunalRequired = input.decision === "dispute" || (input.decision === "accept" && commission.requires_tribunal);
    if (tribunalRequired) {
      const reason = input.decision === "dispute"
        ? input.rationale
        : `Client accepted the submission and requested the required independent evaluator sign-off. ${input.rationale}`;
      const created = await client.query<{ id: string }>(
        `INSERT INTO tribunal_cases (commission_id, opened_by, reason, evidence)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
        [commissionId, clientUserId, reason,
          JSON.stringify([{ submissionId, clientDecision: input.decision, clientRationale: input.rationale }])],
      );
      tribunalCaseId = created.rows[0].id;
      await client.query("UPDATE commissions SET status = 'disputed', updated_at = now() WHERE id = $1", [commissionId]);
    } else if (input.decision === "accept") {
      await client.query("UPDATE commissions SET status = 'approved', updated_at = now() WHERE id = $1", [commissionId]);
    } else {
      await client.query("UPDATE commissions SET status = 'funded', updated_at = now() WHERE id = $1", [commissionId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const wardenAssigned = tribunalCaseId ? await openTribunalCase(tribunalCaseId).catch(() => false) : false;
  const settlement = input.decision === "accept" && !tribunalCaseId
    ? await settleCommission(commissionId, "release")
    : null;
  return { data: { commissionId, submissionId, ...input, tribunalCaseId, wardenAssigned, settlement } };
}
