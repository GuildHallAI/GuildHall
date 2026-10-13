ALTER TABLE commission_escrow_operations
  DROP CONSTRAINT commission_escrow_operations_state_check,
  ADD CONSTRAINT commission_escrow_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));

ALTER TABLE commission_escrow_operation_attempts
  DROP CONSTRAINT commission_escrow_operation_attempts_state_check,
  ADD CONSTRAINT commission_escrow_operation_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

WITH latest_attempt AS (
  SELECT DISTINCT ON (operation_id) operation_id, id, state
    FROM commission_escrow_operation_attempts
   ORDER BY operation_id, created_at DESC, id DESC
)
UPDATE commission_escrow_operations operation
   SET state = 'outcome_unknown', updated_at = now()
  FROM latest_attempt attempt
 WHERE operation.id = attempt.operation_id
   AND operation.state = 'pending'
   AND attempt.state = 'expired';

UPDATE commission_escrow_operation_attempts attempt
   SET state = 'outcome_unknown', updated_at = now()
  FROM commission_escrow_operations operation
 WHERE operation.id = attempt.operation_id
   AND operation.state = 'outcome_unknown'
   AND attempt.state = 'expired';
