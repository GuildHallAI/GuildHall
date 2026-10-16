DROP INDEX surety_one_pending_deposit_idx;

CREATE UNIQUE INDEX surety_one_pending_deposit_per_underwriter_idx
  ON surety_pool_deposits (user_id)
  WHERE state = 'awaiting';
