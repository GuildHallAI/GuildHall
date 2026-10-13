ALTER TABLE charter_buyback_attempts
  DROP CONSTRAINT charter_buyback_attempts_state_check,
  ADD CONSTRAINT charter_buyback_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

DROP INDEX charter_buyback_attempts_pending_idx;
CREATE INDEX charter_buyback_attempts_pending_idx
  ON charter_buyback_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted', 'expired', 'outcome_unknown');
