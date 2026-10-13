CREATE TABLE x_oauth_states (
  state_hash BYTEA PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE CASCADE,
  encrypted_verifier BYTEA NOT NULL,
  verifier_nonce BYTEA NOT NULL,
  verifier_auth_tag BYTEA NOT NULL,
  verifier_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (verifier_key_version = 1),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX x_oauth_states_expiry_idx ON x_oauth_states (expires_at);

CREATE TABLE x_user_links (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL UNIQUE CHECK (x_user_id ~ '^[0-9]{1,30}$'),
  username TEXT NOT NULL CHECK (char_length(username) BETWEEN 1 AND 50),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE x_bounty_commands (
  tweet_id TEXT PRIMARY KEY CHECK (tweet_id ~ '^[0-9]{1,30}$'),
  author_x_user_id TEXT NOT NULL CHECK (author_x_user_id ~ '^[0-9]{1,30}$'),
  tweet_text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'created', 'ignored', 'failed')),
  commission_id UUID REFERENCES bounties(commission_id) ON DELETE RESTRICT,
  failure_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CHECK ((state = 'created') = (commission_id IS NOT NULL))
);
CREATE INDEX x_bounty_commands_pending_idx ON x_bounty_commands (created_at)
  WHERE state = 'pending';

CREATE TABLE x_bot_cursors (
  name TEXT PRIMARY KEY,
  last_tweet_id TEXT CHECK (last_tweet_id IS NULL OR last_tweet_id ~ '^[0-9]{1,30}$'),
  poll_since_id TEXT CHECK (poll_since_id IS NULL OR poll_since_id ~ '^[0-9]{1,30}$'),
  pagination_token TEXT,
  pending_max_tweet_id TEXT CHECK (pending_max_tweet_id IS NULL OR pending_max_tweet_id ~ '^[0-9]{1,30}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bounty_x_posts ADD COLUMN reply_to_tweet_id TEXT
  CHECK (reply_to_tweet_id IS NULL OR reply_to_tweet_id ~ '^[0-9]{1,30}$');
