CREATE TABLE interop_job_exports (
  commission_id UUID PRIMARY KEY REFERENCES commissions(id) ON DELETE RESTRICT,
  export_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  published_by UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unpublished_at TIMESTAMPTZ,
  CHECK (unpublished_at IS NULL OR unpublished_at >= published_at)
);
CREATE INDEX interop_job_exports_active_idx ON interop_job_exports (published_at DESC)
  WHERE unpublished_at IS NULL;
