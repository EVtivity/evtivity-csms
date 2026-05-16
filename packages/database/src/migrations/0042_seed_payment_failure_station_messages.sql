-- Seed the four event-driven station-message templates that the payment gate
-- pushes one-shot to the station screen when it has to stop a session.
-- ON CONFLICT DO NOTHING so operators who later edit a template are not
-- overwritten on re-deploy.
INSERT INTO station_message_templates (state, body) VALUES
  ('payment_failed', E'Payment declined.\nUpdate your card in the app and try again.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}'),
  ('payment_required', E'Add a payment method\nin the app to start charging.\n{{companyName}}'),
  ('guest_unauthorized', E'Guest payment not authorized.\nScan the QR code\nto restart checkout.'),
  ('unauthorized', E'Tap your RFID card\nor scan the QR code\nto authorize charging.')
ON CONFLICT (state) DO NOTHING;
