ALTER TABLE tribunal_cases
  ADD COLUMN panel_vote_deadline_at TIMESTAMPTZ;

UPDATE tribunal_cases tc
   SET panel_vote_deadline_at = COALESCE(panel_assignment.assigned_at, tc.updated_at) + interval '24 hours'
  FROM (
    SELECT case_id, min(assigned_at) AS assigned_at
      FROM tribunal_assignments
     WHERE tier = 'panel'
     GROUP BY case_id
  ) panel_assignment
 WHERE panel_assignment.case_id = tc.id
   AND tc.stage = 'panel';

CREATE INDEX tribunal_panel_vote_deadline_idx
  ON tribunal_cases (panel_vote_deadline_at)
  WHERE stage = 'panel' AND panel_vote_deadline_at IS NOT NULL;
