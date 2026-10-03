-- The Stripe webhook signing secret is an operator setting, encrypted at rest
-- like stripe.secretKeyEnc. It replaces the STRIPE_WEBHOOK_SECRET environment
-- variable. Empty until the operator enters it in Settings > Payment > Stripe.

INSERT INTO settings (key, value) VALUES ('stripe.webhookSecretEnc', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
