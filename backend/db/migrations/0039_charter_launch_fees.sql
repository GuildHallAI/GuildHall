CREATE TABLE charter_launch_fee_payments (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  mint TEXT NOT NULL,
  treasury_wallet TEXT NOT NULL,
  payment_signature TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'paid') = (payment_signature IS NOT NULL AND paid_at IS NOT NULL))
);
