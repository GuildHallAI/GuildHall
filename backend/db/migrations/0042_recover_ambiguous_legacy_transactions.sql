WITH ambiguous AS (
  SELECT DISTINCT ON (a.operation_id) a.operation_id, a.state
    FROM agent_transfer_attempts a
   ORDER BY a.operation_id, a.created_at DESC, a.id DESC
)
UPDATE agent_daily_spend spend
   SET spent_atomic = spend.spent_atomic + operation.amount_atomic,
       updated_at = now()
  FROM agent_transfer_operations operation
  JOIN ambiguous attempt ON attempt.operation_id = operation.id
 WHERE spend.account_id = operation.account_id
   AND spend.usage_date = operation.usage_date
   AND operation.state = 'failed'
   AND operation.failure_code = 'account_disabled'
   AND attempt.state = 'expired'
   AND operation.budget_reserved = true;

WITH ambiguous AS (
  SELECT DISTINCT ON (a.operation_id) a.operation_id, a.state
    FROM agent_transfer_attempts a
   ORDER BY a.operation_id, a.created_at DESC, a.id DESC
)
UPDATE agent_transfer_operations operation
   SET state = 'submitted', failure_code = NULL, updated_at = now()
  FROM ambiguous attempt
 WHERE attempt.operation_id = operation.id
   AND operation.state = 'failed'
   AND operation.failure_code = 'account_disabled'
   AND attempt.state = 'expired';

UPDATE proving_ground_funded_trades
   SET state = 'submitted', failure_code = NULL, updated_at = now()
 WHERE state = 'expired';

UPDATE proving_ground_profit_settlements
   SET state = 'submitted', failure_code = NULL, updated_at = now()
 WHERE state = 'expired';
