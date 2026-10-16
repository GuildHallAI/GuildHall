-- Wash-trade and Sybil signals for settled work, computed from recorded settlements.
--   self_dealing     the client is also paid by the record, or owns the provider agent
--   reciprocal_pair  the paid worker has also paid this client for other settled work
--   repeat_pair      the same client paid the same provider three or more times in the prior 30 days
--   micro_payment    the commission was below 1.000000 units of its stablecoin
-- reputation_weight: 0 removes the record from reputation, 0.5 halves it, 1 counts in full.
CREATE VIEW work_record_integrity_flags AS
WITH paid_parties AS (
  SELECT wr.id AS work_record_id, wr.client_user_id, COALESCE(p.user_id, wr.provider_user_id) AS worker_user_id,
         COALESCE(p.amount_atomic, wr.paid_amount_atomic) AS paid_atomic
    FROM work_records wr LEFT JOIN work_record_payouts p ON p.work_record_id = wr.id
), flagged AS (
  SELECT wr.id AS work_record_id, wr.commission_id, array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM paid_parties s WHERE s.work_record_id = wr.id AND s.worker_user_id = wr.client_user_id)
           OR EXISTS (SELECT 1 FROM work_agents a WHERE a.id = wr.provider_agent_id AND a.owner_user_id = wr.client_user_id)
         THEN 'self_dealing' END,
    CASE WHEN EXISTS (
           SELECT 1 FROM paid_parties s
             JOIN paid_parties reverse ON reverse.client_user_id = s.worker_user_id AND reverse.worker_user_id = s.client_user_id
            WHERE s.work_record_id = wr.id AND reverse.work_record_id <> wr.id AND reverse.paid_atomic > 0)
         THEN 'reciprocal_pair' END,
    CASE WHEN (SELECT count(*) FROM work_records earlier
                WHERE earlier.client_user_id = wr.client_user_id AND earlier.provider_user_id = wr.provider_user_id
                  AND earlier.id <> wr.id AND earlier.finalized_at <= wr.finalized_at
                  AND earlier.finalized_at > wr.finalized_at - interval '30 days') >= 3
         THEN 'repeat_pair' END,
    CASE WHEN wr.amount_atomic < 1000000 THEN 'micro_payment' END
  ]::text[], NULL) AS flags
    FROM work_records wr
)
SELECT work_record_id, commission_id, flags,
       CASE WHEN flags && ARRAY['self_dealing', 'reciprocal_pair'] THEN 0::numeric
            WHEN cardinality(flags) > 0 THEN 0.5
            ELSE 1::numeric END AS reputation_weight
  FROM flagged;
