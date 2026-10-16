CREATE TABLE commission_activity (
  id BIGSERIAL PRIMARY KEY,
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'posted', 'funded', 'accepted', 'submitted', 'accepted_for_payment',
    'changes_requested', 'disputed', 'settling', 'completed', 'refunded', 'cancelled', 'status_changed'
  )),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX commission_activity_commission_idx
  ON commission_activity (commission_id, created_at DESC, id DESC);

CREATE FUNCTION record_commission_status_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  activity_type TEXT;
  event_details JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO commission_activity (commission_id, event_type)
    VALUES (NEW.id, 'posted');
    RETURN NEW;
  END IF;

  IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
    INSERT INTO commission_activity (commission_id, event_type)
    VALUES (NEW.id, 'accepted');
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'submitted'
       OR (NEW.status = 'funded' AND NEW.funding_signature IS NOT DISTINCT FROM OLD.funding_signature) THEN
      RETURN NEW;
    END IF;
    activity_type := CASE NEW.status
      WHEN 'funded' THEN 'funded'
      WHEN 'submitted' THEN 'submitted'
      WHEN 'approved' THEN 'accepted_for_payment'
      WHEN 'disputed' THEN 'disputed'
      WHEN 'complete' THEN 'completed'
      WHEN 'refunded' THEN 'refunded'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'refund_pending' THEN 'settling'
      WHEN 'split_pending' THEN 'settling'
      ELSE 'status_changed'
    END;
    IF NEW.funding_signature IS NOT NULL AND NEW.funding_signature IS DISTINCT FROM OLD.funding_signature THEN
      event_details := jsonb_build_object('signature', NEW.funding_signature);
    END IF;
    INSERT INTO commission_activity (commission_id, event_type, details)
    VALUES (NEW.id, activity_type, event_details);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commissions_record_activity_insert
  AFTER INSERT ON commissions
  FOR EACH ROW EXECUTE FUNCTION record_commission_status_activity();

CREATE TRIGGER commissions_record_activity_update
  AFTER UPDATE OF status, accepted_at ON commissions
  FOR EACH ROW EXECUTE FUNCTION record_commission_status_activity();

CREATE FUNCTION record_commission_submission_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO commission_activity (commission_id, event_type, details, created_at)
  VALUES (NEW.commission_id, 'submitted', jsonb_build_object('revision', NEW.revision), NEW.submitted_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_submissions_record_activity
  AFTER INSERT ON commission_submissions
  FOR EACH ROW EXECUTE FUNCTION record_commission_submission_activity();

CREATE FUNCTION record_commission_review_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision = 'request_changes' THEN
    INSERT INTO commission_activity (commission_id, event_type, details, created_at)
    VALUES (NEW.commission_id, 'changes_requested', jsonb_build_object('decision', NEW.decision), NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_reviews_record_activity
  AFTER INSERT ON commission_reviews
  FOR EACH ROW EXECUTE FUNCTION record_commission_review_activity();

-- Backfill the current commission state so existing commissions have a useful timeline.
INSERT INTO commission_activity (commission_id, event_type, created_at)
SELECT id, 'posted', created_at FROM commissions;
INSERT INTO commission_activity (commission_id, event_type, details, created_at)
SELECT id, 'funded', jsonb_build_object('signature', funding_signature), funded_at
FROM commissions WHERE funded_at IS NOT NULL;
INSERT INTO commission_activity (commission_id, event_type, created_at)
SELECT id, 'accepted', accepted_at FROM commissions WHERE accepted_at IS NOT NULL;
INSERT INTO commission_activity (commission_id, event_type, details, created_at)
SELECT commission_id, 'submitted', jsonb_build_object('revision', revision), submitted_at
FROM commission_submissions;
INSERT INTO commission_activity (commission_id, event_type, details, created_at)
SELECT commission_id,
       CASE decision WHEN 'accept' THEN 'accepted_for_payment'
            WHEN 'request_changes' THEN 'changes_requested' ELSE 'disputed' END,
       jsonb_build_object('decision', decision), created_at
FROM commission_reviews;
INSERT INTO commission_activity (commission_id, event_type, created_at)
SELECT id,
       CASE status WHEN 'complete' THEN 'completed' WHEN 'refunded' THEN 'refunded'
            WHEN 'cancelled' THEN 'cancelled' WHEN 'approved' THEN 'settling'
            WHEN 'disputed' THEN 'disputed' ELSE 'status_changed' END,
       updated_at
FROM commissions WHERE status IN ('complete', 'refunded', 'cancelled', 'approved', 'disputed');
