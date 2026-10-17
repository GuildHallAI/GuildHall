import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "./db/index.js";
import { ApiError } from "./http.js";
import { encryptPrivateData } from "./private-data.js";
import { acceptancePackHash, acceptancePackSchema, verifyAcceptancePack } from "./acceptance-pack.js";
import { openTribunalCase } from "./tribunal.js";
import { settleCommission } from "./escrow-settlement.js";

export const evidenceItemSchema = z.object({
  kind: z.enum(["url", "text", "hash", "image", "photo", "timestamp", "location_cell", "checklist"]),
  label: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(50_000),
}).superRefine((item, context) => {
  if (item.kind !== "text" && item.value.length > 4_000) {
    context.addIssue({ code: "too_big", maximum: 4_000, origin: "string", inclusive: true, path: ["value"], message: "Structured evidence values cannot exceed 4,000 characters." });
  }
});

const submissionSchema = z.object({
  summary: z.string().trim().min(1).max(5000),
  evidence: z.array(evidenceItemSchema).min(1).max(50),
});

type CommissionForSubmission = {
  id: string;
  provider_user_id: string | null;
  provider_agent_id: string | null;
  status: string;
  deadline_at: Date;
  work_type: string;
  accepted_at: Date | null;
  proof_schema: string[] | null;
  acceptance_pack: unknown | null;
};

function validateHandsProof(required: string[], evidence: z.infer<typeof evidenceItemSchema>[]) {
  const submittedKinds = evidence.map((item) => item.kind);
  if (required.length !== submittedKinds.length || required.some((kind) => submittedKinds.filter((item) => item === kind).length !== 1)) {
    throw new ApiError(400, "hand_proof_incomplete", `Provide each required proof item exactly once: ${required.join(", ")}.`);
  }
  for (const item of evidence) {
    if (item.kind === "photo" && (!item.value.startsWith("https://") || item.value.length > 2000)) {
      throw new ApiError(400, "invalid_hand_photo", "Photo proof must be an HTTPS URL to the uploaded image.");
    }
    if (item.kind === "timestamp" && !z.string().datetime({ offset: true }).safeParse(item.value).success) {
      throw new ApiError(400, "invalid_hand_timestamp", "Timestamp proof must be a valid ISO date/time.");
    }
    if (item.kind === "location_cell" && !/^[0123456789bcdefghjkmnpqrstuvwxyz]{4,6}$/i.test(item.value)) {
      throw new ApiError(400, "invalid_location_cell", "Location proof must be a coarse geohash cell (4–6 characters), never raw coordinates.");
    }
    if (item.kind === "checklist") {
      let checklist: unknown;
      try { checklist = JSON.parse(item.value); } catch { checklist = null; }
      const valid = Array.isArray(checklist) && checklist.length > 0 && checklist.length <= 40
        && checklist.every((entry) => entry && typeof entry === "object"
          && typeof entry.id === "string" && entry.id.length <= 80
          && typeof entry.completed === "boolean");
      if (!valid) throw new ApiError(400, "invalid_hand_checklist", "Checklist proof must be a JSON array of { id, completed } items.");
    }
  }
}

async function ensureCrewWorkComplete(db: PoolClient, commission: CommissionForSubmission) {
  if (!commission.accepted_at) throw new ApiError(409, "crew_lead_not_accepted", "The crew lead must accept the funded commission before submitting the group's work.");
  const tasks = await db.query<{ total: number; accepted: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'accepted')::int AS accepted
       FROM crew_tasks WHERE commission_id = $1`, [commission.id],
  );
  if (!tasks.rows[0].total || tasks.rows[0].accepted !== tasks.rows[0].total) {
    throw new ApiError(409, "crew_tasks_incomplete", "Every assigned crew sub-task must be accepted by the crew lead before the full submission.");
  }
}

export async function submitCommissionWork(commissionId: string, providerUserId: string, value: unknown, providerAgentId?: string) {
  const input = submissionSchema.parse(value);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [commissionId]);
    const selected = await client.query<CommissionForSubmission>(
      "SELECT id, provider_user_id, provider_agent_id, status, deadline_at, work_type, accepted_at, proof_schema, acceptance_pack FROM commissions WHERE id = $1 FOR UPDATE",
      [commissionId],
    );
    const commission = selected.rows[0];
    if (!commission) throw new ApiError(404, "commission_not_found", "Commission not found.");
    if (commission.provider_user_id !== providerUserId || (providerAgentId && commission.provider_agent_id !== providerAgentId)) {
      throw new ApiError(403, "commission_forbidden", "Only the assigned provider can submit work.");
    }
    if (!["funded", "submitted"].includes(commission.status)) throw new ApiError(409, "commission_not_submittable", "This commission is not accepting a submission.");
    if (commission.deadline_at <= new Date()) throw new ApiError(409, "commission_expired", "The deadline has passed; late submissions cannot be added to this commission.");
    if (["crew", "guild"].includes(commission.work_type)) await ensureCrewWorkComplete(client, commission);
    if (commission.work_type === "hand") {
      validateHandsProof(commission.proof_schema ?? [], input.evidence);
    } else if (input.evidence.some((item) => ["photo", "timestamp", "location_cell", "checklist"].includes(item.kind))) {
      throw new ApiError(400, "invalid_evidence_kind", "Structured Hands proof is only accepted for Hands tasks.");
    }

    const imageIds = input.evidence.filter((item) => item.kind === "image").map((item) => item.value);
    if (imageIds.length > 5 || new Set(imageIds).size !== imageIds.length) {
      throw new ApiError(400, "invalid_submission_images", "Attach at most five different generated image assets per submission.");
    }
    if (imageIds.some((assetId) => !z.string().uuid().safeParse(assetId).success)) {
      throw new ApiError(400, "invalid_submission_images", "Image evidence must reference an uploaded GuildHall image asset.");
    }
    const submissionAgentId = providerAgentId ?? commission.provider_agent_id ?? undefined;

    const previous = await client.query<{ revision: number }>(
      "SELECT COALESCE(MAX(revision), 0)::int AS revision FROM commission_submissions WHERE commission_id = $1", [commissionId],
    );
    const encrypted = encryptPrivateData(input);
    const inserted = await client.query<{ id: string; revision: number; submitted_at: Date }>(
      `INSERT INTO commission_submissions
         (commission_id, provider_user_id, revision, encrypted_payload, encryption_nonce, encryption_auth_tag, encryption_key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, revision, submitted_at`,
      [commissionId, providerUserId, previous.rows[0].revision + 1,
        encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
    );
    if (imageIds.length) {
      const linked = await client.query(
        `UPDATE commission_submission_assets
            SET submission_id = $2
          WHERE id = ANY($1::uuid[]) AND commission_id = $3 AND provider_user_id = $4
            AND provider_agent_id IS NOT DISTINCT FROM $5::uuid AND submission_id IS NULL`,
        [imageIds, inserted.rows[0].id, commissionId, providerUserId, submissionAgentId ?? null],
      );
      if (linked.rowCount !== imageIds.length) {
        throw new ApiError(400, "submission_image_unavailable", "One or more images were not uploaded for this commission by its assigned provider.");
      }
    }
    let verification: ReturnType<typeof verifyAcceptancePack> | null = null;
    let autoRelease = false;
    let tribunalCaseId: string | null = null;
    if (commission.acceptance_pack) {
      const pack = acceptancePackSchema.parse(commission.acceptance_pack);
      verification = verifyAcceptancePack(pack, input);
      await client.query(
        `INSERT INTO commission_submission_verifications (commission_id, submission_id, pack_hash, status, results)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [commissionId, inserted.rows[0].id, acceptancePackHash(pack), verification.status, JSON.stringify(verification.results)],
      );
      if (pack.settlement === "auto_release" && verification.status === "passed") {
        autoRelease = true;
        await client.query("UPDATE commissions SET status = 'approved', updated_at = now() WHERE id = $1", [commissionId]);
      } else if (pack.settlement === "auto_release") {
        const created = await client.query<{ id: string }>(
          `INSERT INTO tribunal_cases (commission_id, opened_by, reason, evidence)
           SELECT $1, client_user_id, $2, $3::jsonb FROM commissions WHERE id = $1 RETURNING id`,
          [commissionId, "Proof Pack failed; settlement is held for Tribunal review.", JSON.stringify([{ submissionId: inserted.rows[0].id, acceptancePack: verification }])],
        );
        tribunalCaseId = created.rows[0].id;
        await client.query("UPDATE commissions SET status = 'disputed', updated_at = now() WHERE id = $1", [commissionId]);
      } else {
        await client.query("UPDATE commissions SET status = 'submitted', updated_at = now() WHERE id = $1", [commissionId]);
      }
    } else {
      await client.query("UPDATE commissions SET status = 'submitted', updated_at = now() WHERE id = $1", [commissionId]);
    }
    await client.query("COMMIT");
    const wardenAssigned = tribunalCaseId ? await openTribunalCase(tribunalCaseId).catch(() => false) : false;
    const settlement = autoRelease ? await settleCommission(commissionId, "release") : null;
    return { id: inserted.rows[0].id, revision: inserted.rows[0].revision,
      submitted_at: inserted.rows[0].submitted_at, summary: input.summary, evidence: input.evidence,
      verification, tribunalCaseId, wardenAssigned, settlement };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
