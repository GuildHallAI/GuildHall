ALTER TABLE commissions
  ADD COLUMN funding_instructions_message_hash TEXT,
  ADD COLUMN funding_submission_signature TEXT;
