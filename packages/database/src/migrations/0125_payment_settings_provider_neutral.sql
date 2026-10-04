-- P5 (D-P3): provider-neutral pre-authorization amount and platform fee, and
-- the test (simulated) provider settings. The stripe.* values are copied, so an
-- upgrade keeps the operator's amounts; installs without them get the defaults.
-- The API writes both forms until P8 deletes the stripe.* keys, so pods of the
-- previous release read the operator's value during a rolling upgrade.

INSERT INTO settings (key, value)
SELECT 'payments.preAuthAmountCents', value FROM settings WHERE key = 'stripe.preAuthAmountCents'
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO settings (key, value)
SELECT 'payments.platformFeePercent', value FROM settings WHERE key = 'stripe.platformFeePercent'
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES
  ('payments.preAuthAmountCents', '5000'::jsonb),
  ('payments.platformFeePercent', '0'::jsonb),
  ('simulated.resultMode', '"sync"'::jsonb),
  ('simulated.asyncDelaySeconds', '3'::jsonb),
  ('simulated.randomFailureRate', '0.2'::jsonb)
ON CONFLICT (key) DO NOTHING;
