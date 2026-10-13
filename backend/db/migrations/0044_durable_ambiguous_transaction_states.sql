ALTER TABLE agent_transfer_operations
  DROP CONSTRAINT agent_transfer_operations_state_check,
  ADD CONSTRAINT agent_transfer_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));
ALTER TABLE agent_transfer_attempts
  DROP CONSTRAINT agent_transfer_attempts_state_check,
  ADD CONSTRAINT agent_transfer_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));
DROP INDEX agent_transfer_operations_pending_idx;
CREATE INDEX agent_transfer_operations_pending_idx ON agent_transfer_operations (created_at)
  WHERE state IN ('pending', 'submitted', 'outcome_unknown');

ALTER TABLE bounty_bond_operations
  DROP CONSTRAINT bounty_bond_operations_state_check,
  ADD CONSTRAINT bounty_bond_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'empty', 'outcome_unknown'));
ALTER TABLE bounty_bond_operation_attempts
  DROP CONSTRAINT bounty_bond_operation_attempts_state_check,
  ADD CONSTRAINT bounty_bond_operation_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));
DROP INDEX bounty_bond_operations_pending_idx;
CREATE INDEX bounty_bond_operations_pending_idx ON bounty_bond_operations (updated_at)
  WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown');

ALTER TABLE evaluator_slash_operations
  DROP CONSTRAINT evaluator_slash_operations_state_check,
  ADD CONSTRAINT evaluator_slash_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));
ALTER TABLE evaluator_slash_attempts
  DROP CONSTRAINT evaluator_slash_attempts_state_check,
  ADD CONSTRAINT evaluator_slash_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

ALTER TABLE evaluator_stake_withdrawals
  DROP CONSTRAINT evaluator_stake_withdrawals_state_check,
  ADD CONSTRAINT evaluator_stake_withdrawals_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));
ALTER TABLE evaluator_stake_withdrawal_attempts
  DROP CONSTRAINT evaluator_stake_withdrawal_attempts_state_check,
  ADD CONSTRAINT evaluator_stake_withdrawal_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

ALTER TABLE work_record_chain_operations
  DROP CONSTRAINT work_record_chain_operations_state_check,
  ADD CONSTRAINT work_record_chain_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));
ALTER TABLE work_record_chain_attempts
  DROP CONSTRAINT work_record_chain_attempts_state_check,
  ADD CONSTRAINT work_record_chain_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));
DROP INDEX work_record_chain_operations_pending_idx;
CREATE INDEX work_record_chain_operations_pending_idx ON work_record_chain_operations (created_at)
  WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown');
