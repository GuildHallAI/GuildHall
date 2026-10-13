CREATE TABLE bounty_x_posts (
  commission_id UUID NOT NULL REFERENCES bounties(commission_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('announcement', 'receipt')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'prepared', 'published', 'failed', 'outcome_unknown')),
  action_url TEXT NOT NULL,
  blink_url TEXT NOT NULL,
  tweet_id TEXT UNIQUE,
  tweet_url TEXT,
  failure_code TEXT,
  attempted_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (commission_id, kind),
  CHECK ((state = 'published') = (tweet_id IS NOT NULL AND tweet_url IS NOT NULL AND published_at IS NOT NULL))
);

CREATE INDEX bounty_x_posts_pending_idx ON bounty_x_posts (kind, created_at)
  WHERE state = 'pending';
CREATE INDEX bounty_x_posts_prepared_idx ON bounty_x_posts (attempted_at)
  WHERE state = 'prepared';
