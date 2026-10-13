CREATE TABLE commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_wallet TEXT NOT NULL,
  provider_wallet TEXT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL,
  asset_mint TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'funded', 'submitted', 'complete', 'disputed', 'cancelled', 'refunded')),
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE commission_escrow_wallets
  ADD CONSTRAINT commission_escrow_wallets_commission_fk
  FOREIGN KEY (commission_id) REFERENCES commissions(id) ON DELETE RESTRICT;
