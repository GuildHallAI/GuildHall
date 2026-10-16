import { pool } from "./db/index.js";
import { ApiError } from "./http.js";
import { deleteCommissionImage, uploadCommissionImage } from "./cloudinary-assets.js";

export async function stageCommissionImage(input: {
  commissionId: string;
  providerUserId: string;
  providerAgentId?: string;
  bytes: Buffer;
  contentType: string;
}) {
  const assigned = await pool.query<{ status: string; provider_agent_id: string | null }>(
    `SELECT c.status, c.provider_agent_id FROM commissions c
      WHERE c.id = $1 AND c.provider_user_id = $2
        AND ($3::uuid IS NULL OR c.provider_agent_id = $3::uuid)`,
    [input.commissionId, input.providerUserId, input.providerAgentId ?? null],
  );
  if (!assigned.rowCount) throw new ApiError(403, "commission_forbidden", "Only the assigned provider can attach images to this commission.");
  if (assigned.rows[0].status !== "funded") throw new ApiError(409, "commission_not_submittable", "Images can only be attached before submitting funded work.");

  const staged = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM commission_submission_assets
      WHERE commission_id = $1 AND provider_user_id = $2 AND provider_agent_id IS NOT DISTINCT FROM $3::uuid
        AND submission_id IS NULL`,
    [input.commissionId, input.providerUserId, assigned.rows[0].provider_agent_id],
  );
  if (staged.rows[0].count >= 5) throw new ApiError(409, "commission_image_limit", "This commission already has five staged images.");

  const uploaded = await uploadCommissionImage(input.commissionId, input.bytes, input.contentType);
  try {
    const result = await pool.query<{ id: string; format: string; content_type: string; byte_size: number; width: number; height: number }>(
      `INSERT INTO commission_submission_assets
         (commission_id, provider_user_id, provider_agent_id, cloudinary_public_id, format, content_type, byte_size, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, format, content_type, byte_size, width, height`,
      [input.commissionId, input.providerUserId, assigned.rows[0].provider_agent_id, uploaded.public_id,
        uploaded.format, input.contentType, uploaded.bytes, uploaded.width, uploaded.height],
    );
    return result.rows[0];
  } catch (error) {
    await deleteCommissionImage(uploaded.public_id).catch(() => undefined);
    throw error;
  }
}

export async function discardStagedCommissionImage(input: {
  commissionId: string;
  assetId: string;
  providerUserId: string;
  providerAgentId?: string;
}) {
  const deleted = await pool.query<{ cloudinary_public_id: string }>(
    `DELETE FROM commission_submission_assets
      WHERE id = $1 AND commission_id = $2 AND provider_user_id = $3
        AND ($4::uuid IS NULL OR provider_agent_id = $4::uuid) AND submission_id IS NULL
      RETURNING cloudinary_public_id`,
    [input.assetId, input.commissionId, input.providerUserId, input.providerAgentId ?? null],
  );
  if (!deleted.rowCount) throw new ApiError(404, "commission_image_not_found", "Staged image not found.");
  await deleteCommissionImage(deleted.rows[0].cloudinary_public_id);
}
