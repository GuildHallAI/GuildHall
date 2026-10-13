ALTER TABLE ghall_stake_withdrawals
  DROP CONSTRAINT ghall_stake_withdrawals_state_check,
  ADD CONSTRAINT ghall_stake_withdrawals_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));

ALTER TABLE ghall_stake_withdrawal_attempts
  DROP CONSTRAINT ghall_stake_withdrawal_attempts_state_check,
  ADD CONSTRAINT ghall_stake_withdrawal_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

DROP INDEX ghall_stake_withdrawals_pending_idx;
CREATE INDEX ghall_stake_withdrawals_pending_idx ON ghall_stake_withdrawals (created_at)
  WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown');

DROP INDEX ghall_stake_withdrawal_attempts_pending_idx;
CREATE INDEX ghall_stake_withdrawal_attempts_pending_idx ON ghall_stake_withdrawal_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted', 'outcome_unknown');
