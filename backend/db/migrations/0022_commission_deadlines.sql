UPDATE commissions
   SET deadline_at = created_at + interval '168 hours'
 WHERE deadline_at IS NULL;

ALTER TABLE commissions ALTER COLUMN deadline_at SET NOT NULL;
ALTER TABLE commissions ADD CONSTRAINT commissions_deadline_after_creation
  CHECK (deadline_at > created_at);

CREATE INDEX commissions_expired_work_idx ON commissions (deadline_at)
  WHERE status IN ('funded', 'submitted', 'refund_pending');
