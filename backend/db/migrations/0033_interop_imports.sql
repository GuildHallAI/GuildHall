ALTER TABLE commissions DROP CONSTRAINT commissions_work_type_check;
ALTER TABLE commissions ADD CONSTRAINT commissions_work_type_check
  CHECK (work_type IN ('standard', 'hand', 'bounty', 'crew', 'guild', 'proving_ground', 'interop'));

CREATE TABLE interop_job_imports (
  commission_id UUID PRIMARY KEY REFERENCES commissions(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9_.-]{1,63}$'),
  external_job_id TEXT NOT NULL CHECK (char_length(external_job_id) BETWEEN 1 AND 200),
  source_url TEXT CHECK (source_url IS NULL OR source_url ~ '^https://'),
  imported_by UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_job_id)
);
CREATE INDEX interop_job_imports_source_idx ON interop_job_imports (source, imported_at DESC);
