-- The payment provider used for new payments: 'stripe' when a Stripe secret
-- key is already configured, so existing installations keep taking payments,
-- else 'none' (payments off) until the operator selects a provider.

INSERT INTO settings (key, value)
SELECT 'payments.provider',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM settings
      WHERE key = 'stripe.secretKeyEnc' AND value <> '""'::jsonb AND value <> 'null'::jsonb
    ) THEN '"stripe"'::jsonb
    ELSE '"none"'::jsonb
  END
ON CONFLICT (key) DO NOTHING;
