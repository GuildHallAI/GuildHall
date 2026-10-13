CREATE TABLE commission_escrow_wallets (
  commission_id UUID PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commission_escrow_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commission_escrow_wallets(commission_id),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('fund', 'release', 'refund', 'sweep')),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('sol', 'spl')),
  mint TEXT,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  destination TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commission_id, idempotency_key),
  CHECK ((asset_kind = 'sol' AND mint IS NULL) OR (asset_kind = 'spl' AND mint IS NOT NULL))
);

CREATE INDEX commission_escrow_operations_pending_idx
  ON commission_escrow_operations (created_at)
  WHERE state IN ('pending', 'submitted');
