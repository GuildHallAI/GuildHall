ALTER TABLE tribunal_appeal_fee_operations
  DROP CONSTRAINT tribunal_appeal_fee_operations_state_check,
  ADD CONSTRAINT tribunal_appeal_fee_operations_state_check
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'outcome_unknown'));

ALTER TABLE tribunal_appeal_fee_attempts
  DROP CONSTRAINT tribunal_appeal_fee_attempts_state_check,
  ADD CONSTRAINT tribunal_appeal_fee_attempts_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

DROP INDEX tribunal_appeal_fee_ops_pending_idx;
CREATE INDEX tribunal_appeal_fee_ops_pending_idx ON tribunal_appeal_fee_operations (created_at)
  WHERE state IN ('pending', 'submitted', 'failed', 'outcome_unknown');

DROP INDEX tribunal_appeal_fee_attempts_pending_idx;
CREATE INDEX tribunal_appeal_fee_attempts_pending_idx ON tribunal_appeal_fee_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted', 'outcome_unknown');

WITH latest_attempt AS (
  SELECT DISTINCT ON (operation_id) operation_id, id, state
    FROM tribunal_appeal_fee_attempts
   ORDER BY operation_id, created_at DESC, id DESC
)
UPDATE tribunal_appeal_fee_operations operation
   SET state = 'outcome_unknown', updated_at = now()
  FROM latest_attempt attempt
 WHERE operation.id = attempt.operation_id
   AND operation.state IN ('pending', 'submitted', 'failed')
   AND attempt.state = 'expired';

UPDATE tribunal_appeal_fee_attempts attempt
   SET state = 'outcome_unknown', updated_at = now()
  FROM tribunal_appeal_fee_operations operation
 WHERE operation.id = attempt.operation_id
   AND operation.state = 'outcome_unknown'
   AND attempt.state = 'expired';
