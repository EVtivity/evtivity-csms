-- Adyen payment provider settings (plan B6.4). Empty until the operator enters
-- them; payments.provider selects Adyen. *Enc values are encrypted at rest.
-- adyen.authorisationAdjustment stays false until Adyen enables pre-auth
-- adjustment for the merchant category (D-A1).

INSERT INTO settings (key, value) VALUES
  ('adyen.apiKeyEnc', '""'::jsonb),
  ('adyen.merchantAccount', '""'::jsonb),
  ('adyen.clientKey', '""'::jsonb),
  ('adyen.environment', '"test"'::jsonb),
  ('adyen.liveUrlPrefix', '""'::jsonb),
  ('adyen.liveRegion', '"eu"'::jsonb),
  ('adyen.hmacKeyEnc', '""'::jsonb),
  ('adyen.hmacKeyPreviousEnc', '""'::jsonb),
  ('adyen.webhookUsername', '""'::jsonb),
  ('adyen.webhookPasswordEnc', '""'::jsonb),
  ('adyen.authorisationAdjustment', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
