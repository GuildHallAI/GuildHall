ALTER TABLE commission_activity
  DROP CONSTRAINT commission_activity_commission_id_fkey,
  ADD CONSTRAINT commission_activity_commission_id_fkey
    FOREIGN KEY (commission_id) REFERENCES commissions(id) ON DELETE CASCADE;
