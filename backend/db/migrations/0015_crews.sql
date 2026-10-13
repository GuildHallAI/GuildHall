CREATE TABLE crews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE TABLE crew_members (
  crew_id UUID NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (crew_id, user_id)
);
CREATE UNIQUE INDEX crew_single_lead_idx ON crew_members (crew_id) WHERE role = 'lead';
CREATE INDEX crew_members_user_idx ON crew_members (user_id, joined_at DESC);

CREATE TABLE crew_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id UUID NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  invited_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  UNIQUE (crew_id, invited_user_id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

CREATE TABLE crew_commissions (
  commission_id UUID PRIMARY KEY REFERENCES commissions(id) ON DELETE RESTRICT,
  crew_id UUID NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  lead_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crew_commissions_crew_idx ON crew_commissions (crew_id, created_at DESC);

CREATE TABLE commission_payout_shares (
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  wallet_address TEXT NOT NULL,
  share_bps SMALLINT NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  payout_order SMALLINT NOT NULL CHECK (payout_order > 0),
  PRIMARY KEY (commission_id, user_id),
  UNIQUE (commission_id, payout_order)
);

CREATE TABLE crew_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  assignee_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'submitted', 'accepted', 'changes_requested')),
  encrypted_payload BYTEA,
  encryption_nonce BYTEA,
  encryption_auth_tag BYTEA,
  encryption_key_version SMALLINT CHECK (encryption_key_version = 1),
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  review_rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((encrypted_payload IS NULL AND encryption_nonce IS NULL AND encryption_auth_tag IS NULL
          AND encryption_key_version IS NULL AND submitted_at IS NULL)
      OR (encrypted_payload IS NOT NULL AND encryption_nonce IS NOT NULL AND encryption_auth_tag IS NOT NULL
          AND encryption_key_version IS NOT NULL AND encryption_key_version = 1 AND submitted_at IS NOT NULL)),
  CHECK ((status IN ('submitted', 'accepted', 'changes_requested')) = (submitted_at IS NOT NULL)),
  CHECK ((status IN ('accepted', 'changes_requested')) = (reviewed_at IS NOT NULL))
);
CREATE INDEX crew_tasks_assignee_idx ON crew_tasks (assignee_user_id, status, created_at DESC);

CREATE TABLE work_record_payouts (
  work_record_id UUID NOT NULL REFERENCES work_records(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  wallet_address TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic >= 0),
  share_bps SMALLINT NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  PRIMARY KEY (work_record_id, user_id)
);
CREATE INDEX work_record_payouts_user_idx ON work_record_payouts (user_id, work_record_id);
