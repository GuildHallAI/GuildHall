ALTER TABLE bounty_x_posts
  ADD COLUMN not_before_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX bounty_x_posts_due_idx ON bounty_x_posts (not_before_at, created_at)
  WHERE state = 'pending';
