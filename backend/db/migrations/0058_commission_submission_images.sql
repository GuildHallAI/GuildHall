CREATE TABLE commission_submission_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  submission_id UUID REFERENCES commission_submissions(id) ON DELETE RESTRICT,
  provider_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  provider_agent_id UUID REFERENCES work_agents(id) ON DELETE RESTRICT,
  cloudinary_public_id TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('png', 'jpg', 'jpeg', 'webp')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX commission_submission_assets_submission_idx
  ON commission_submission_assets (submission_id, created_at)
  WHERE submission_id IS NOT NULL;

CREATE INDEX commission_submission_assets_staged_idx
  ON commission_submission_assets (commission_id, provider_user_id, created_at)
  WHERE submission_id IS NULL;
