CREATE TABLE task_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  reporter_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  reporter_wallet TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('illegal_or_unsafe', 'minors', 'harassment', 'surveillance', 'personal_data', 'other')),
  details TEXT NOT NULL CHECK (char_length(details) BETWEEN 1 AND 5000),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolution TEXT CHECK (resolution IN ('action_taken', 'no_violation', 'needs_followup')),
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 5000),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_user_id, idempotency_key),
  CHECK ((state = 'open' AND resolution IS NULL AND resolved_at IS NULL)
      OR (state = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX task_reports_open_idx ON task_reports (created_at, id)
  WHERE state = 'open';
CREATE UNIQUE INDEX task_reports_one_open_per_reporter_idx ON task_reports (commission_id, reporter_user_id)
  WHERE state = 'open';
CREATE INDEX task_reports_commission_idx ON task_reports (commission_id, created_at DESC);
