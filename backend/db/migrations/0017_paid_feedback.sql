CREATE TABLE work_record_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_record_id UUID NOT NULL REFERENCES work_records(id) ON DELETE RESTRICT,
  reviewer_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  target_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL CHECK (char_length(comment) BETWEEN 1 AND 4000),
  weight_atomic NUMERIC(20, 0) NOT NULL CHECK (weight_atomic > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_record_id, reviewer_user_id, target_user_id),
  CHECK (reviewer_user_id <> target_user_id)
);
CREATE INDEX work_record_feedback_target_idx ON work_record_feedback (target_user_id, created_at DESC);
