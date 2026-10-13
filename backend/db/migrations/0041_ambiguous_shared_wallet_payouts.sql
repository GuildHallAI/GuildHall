ALTER TABLE guild_bond_returns
  DROP CONSTRAINT guild_bond_returns_state_check,
  ADD CONSTRAINT guild_bond_returns_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));

ALTER TABLE guild_bond_return_attempts
  DROP CONSTRAINT guild_bond_return_attempts_state_check,
  ADD CONSTRAINT guild_bond_return_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

WITH latest_attempt AS (
  SELECT DISTINCT ON (return_id) return_id, id, state
    FROM guild_bond_return_attempts
   ORDER BY return_id, created_at DESC, id DESC
)
UPDATE guild_bond_returns bond_return
   SET state = 'outcome_unknown', updated_at = now()
  FROM latest_attempt attempt
 WHERE bond_return.id = attempt.return_id
   AND bond_return.state IN ('pending', 'submitted', 'failed')
   AND attempt.state = 'expired';

UPDATE guild_bond_return_attempts attempt
   SET state = 'outcome_unknown', updated_at = now()
  FROM guild_bond_returns bond_return
 WHERE bond_return.id = attempt.return_id
   AND bond_return.state = 'outcome_unknown'
   AND attempt.state = 'expired';

ALTER TABLE surety_pool_operations
  DROP CONSTRAINT surety_pool_operations_state_check,
  ADD CONSTRAINT surety_pool_operations_state_check
    CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));

ALTER TABLE surety_pool_operation_attempts
  DROP CONSTRAINT surety_pool_operation_attempts_state_check,
  ADD CONSTRAINT surety_pool_operation_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

WITH latest_attempt AS (
  SELECT DISTINCT ON (operation_id) operation_id, id, state
    FROM surety_pool_operation_attempts
   ORDER BY operation_id, created_at DESC, id DESC
)
UPDATE surety_pool_operations operation
   SET state = 'outcome_unknown', updated_at = now()
  FROM latest_attempt attempt
 WHERE operation.id = attempt.operation_id
   AND operation.state IN ('queued', 'submitted', 'failed')
   AND attempt.state = 'expired';

UPDATE surety_pool_operation_attempts attempt
   SET state = 'outcome_unknown', updated_at = now()
  FROM surety_pool_operations operation
 WHERE operation.id = attempt.operation_id
   AND operation.state = 'outcome_unknown'
   AND attempt.state = 'expired';
