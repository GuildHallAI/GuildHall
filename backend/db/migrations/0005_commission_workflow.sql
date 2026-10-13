ALTER TABLE commissions
  DROP CONSTRAINT commissions_status_check,
  ADD CONSTRAINT commissions_status_check CHECK (
    status IN ('draft', 'open', 'funded', 'submitted', 'under_review', 'disputed', 'approved', 'refund_pending', 'split_pending', 'complete', 'cancelled', 'refunded')
  );

CREATE TABLE commission_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  provider_user_id UUID NOT NULL REFERENCES wallet_users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  encrypted_payload BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commission_id, revision)
);
CREATE INDEX commission_submissions_latest_idx ON commission_submissions (commission_id, revision DESC);

CREATE TABLE commission_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL REFERENCES commission_submissions(id) ON DELETE RESTRICT,
  reviewer_user_id UUID NOT NULL REFERENCES wallet_users(id),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'request_changes', 'dispute')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, reviewer_user_id)
);

CREATE TABLE tribunal_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL UNIQUE REFERENCES commissions(id) ON DELETE RESTRICT,
  opened_by UUID NOT NULL REFERENCES wallet_users(id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 10000),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  stage TEXT NOT NULL DEFAULT 'warden' CHECK (stage IN ('warden', 'panel', 'bench', 'decided', 'cancelled')),
  outcome TEXT CHECK (outcome IN ('client', 'provider', 'split', 'dismissed')),
  decision_summary TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((stage = 'decided') = (decided_at IS NOT NULL))
);

CREATE TABLE tribunal_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES tribunal_cases(id) ON DELETE RESTRICT,
  voter_user_id UUID NOT NULL REFERENCES wallet_users(id),
  tier TEXT NOT NULL CHECK (tier IN ('warden', 'panel', 'bench_ai', 'bench_juror')),
  verdict TEXT NOT NULL CHECK (verdict IN ('client', 'provider', 'split', 'dismissed', 'advance')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, voter_user_id, tier)
);
CREATE INDEX tribunal_votes_case_tier_idx ON tribunal_votes (case_id, tier, created_at);

CREATE TABLE tribunal_assignments (
  case_id UUID NOT NULL REFERENCES tribunal_cases(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id),
  tier TEXT NOT NULL CHECK (tier IN ('warden', 'panel', 'bench_juror')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id, tier)
);

CREATE TABLE work_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL UNIQUE REFERENCES commissions(id) ON DELETE RESTRICT,
  client_user_id UUID NOT NULL REFERENCES wallet_users(id),
  provider_user_id UUID NOT NULL REFERENCES wallet_users(id),
  asset_mint TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  paid_amount_atomic NUMERIC(20, 0) NOT NULL CHECK (paid_amount_atomic >= 0),
  final_submission_id UUID REFERENCES commission_submissions(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'tribunal_client', 'tribunal_provider', 'tribunal_split')),
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_records_provider_idx ON work_records (provider_user_id, finalized_at DESC);
CREATE INDEX work_records_client_idx ON work_records (client_user_id, finalized_at DESC);
