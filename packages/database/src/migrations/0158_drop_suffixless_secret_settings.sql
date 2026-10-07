-- Every credential setting is stored under its `Enc` key. Migration 0001
-- inserted s3.accessKeyId and sso.cert under suffix-less names, and 0047
-- renamed only four keys, so those rows stayed on every install. Nothing
-- reads a suffix-less credential key (the seed maps the plaintext names in
-- seed.config.json to the `Enc` keys before writing). Delete them, and any
-- other suffix-less twin of an `Enc` credential, so no plaintext credential
-- row can remain. Idempotent.
DELETE FROM settings
WHERE key IN (
  's3.accessKeyId',
  's3.secretAccessKey',
  'stripe.secretKey',
  'stripe.webhookSecret',
  'stripe.connectWebhookSecret',
  'adyen.apiKey',
  'adyen.hmacKey',
  'adyen.hmacKeyPrevious',
  'adyen.webhookPassword',
  'security.recaptcha.secretKey',
  'pnc.hubject.clientSecret',
  'pnc.local.ca',
  'chatbotAi.apiKey',
  'supportAi.apiKey',
  'sso.cert',
  'smtp.password',
  'twilio.authToken',
  'ftp.password',
  'googleMaps.apiKey',
  'mobile.attestation.android.serviceAccount'
);
