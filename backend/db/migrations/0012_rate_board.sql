ALTER TABLE commissions
  ADD COLUMN work_category TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN sla_hours SMALLINT,
  ADD CONSTRAINT commissions_sla_hours_check
    CHECK (sla_hours IS NULL OR sla_hours BETWEEN 1 AND 8760);

CREATE INDEX commissions_settled_rate_board_idx ON commissions (work_category, sla_hours, funded_at)
  WHERE status = 'complete';
