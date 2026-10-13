CREATE TABLE rate_board_snapshots (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  market_data JSONB NOT NULL,
  guild_data JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL
);
