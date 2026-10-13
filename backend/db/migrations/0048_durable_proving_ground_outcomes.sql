ALTER TABLE proving_ground_funded_trades
  DROP CONSTRAINT proving_ground_funded_trades_state_check,
  ADD CONSTRAINT proving_ground_funded_trades_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

DROP INDEX proving_ground_funded_trade_queue_idx;
CREATE INDEX proving_ground_funded_trade_queue_idx
  ON proving_ground_funded_trades (created_at)
  WHERE state IN ('prepared', 'submitted', 'outcome_unknown');

ALTER TABLE proving_ground_profit_settlements
  DROP CONSTRAINT proving_ground_profit_settlements_state_check,
  ADD CONSTRAINT proving_ground_profit_settlements_state_check
    CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired', 'outcome_unknown'));

DROP INDEX proving_ground_profit_settlement_queue_idx;
CREATE INDEX proving_ground_profit_settlement_queue_idx
  ON proving_ground_profit_settlements (created_at)
  WHERE state IN ('prepared', 'submitted', 'outcome_unknown');
