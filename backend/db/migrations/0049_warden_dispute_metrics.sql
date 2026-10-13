ALTER TABLE tribunal_cases
  ADD COLUMN warden_decided_at TIMESTAMPTZ,
  ADD COLUMN warden_appealed_at TIMESTAMPTZ;

UPDATE tribunal_cases tc
   SET warden_decided_at = votes.created_at
  FROM (
    SELECT case_id, min(created_at) AS created_at
      FROM tribunal_votes WHERE tier = 'warden' GROUP BY case_id
  ) votes
 WHERE votes.case_id = tc.id;

UPDATE tribunal_cases tc
   SET warden_appealed_at = assignments.assigned_at
  FROM (
    SELECT case_id, min(assigned_at) AS assigned_at
      FROM tribunal_assignments WHERE tier = 'panel' GROUP BY case_id
  ) assignments
 WHERE assignments.case_id = tc.id;

CREATE INDEX tribunal_warden_metrics_idx
  ON tribunal_cases (warden_user_id, warden_decided_at)
  WHERE warden_decided_at IS NOT NULL;
