ALTER TABLE commissions
  ADD COLUMN watch_terms JSONB;

ALTER TABLE commissions
  DROP CONSTRAINT commissions_work_type_check,
  ADD CONSTRAINT commissions_work_type_check
    CHECK (work_type IN ('standard', 'hand', 'bounty', 'crew', 'guild', 'proving_ground', 'interop', 'watch')),
  ADD CONSTRAINT commissions_watch_terms_check
    CHECK ((work_type = 'watch' AND work_category = 'watch' AND jsonb_typeof(watch_terms) = 'object')
        OR (work_type <> 'watch' AND watch_terms IS NULL));

CREATE TABLE watch_commission_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES work_agents(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('deviation', 'thin_ref', 'stale', 'funding_spike')),
  observed_at TIMESTAMPTZ NOT NULL,
  observed_value TEXT NOT NULL,
  reference_value TEXT NOT NULL,
  evidence_url TEXT NOT NULL CHECK (evidence_url LIKE 'https://%'),
  notes TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commission_id, agent_id, idempotency_key)
);

CREATE INDEX watch_commission_alerts_feed_idx
  ON watch_commission_alerts (commission_id, observed_at, created_at);
