ALTER TABLE charters ALTER COLUMN liquidity_unlock_at DROP NOT NULL;
UPDATE charters SET liquidity_unlock_at = NULL;
