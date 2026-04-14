-- Consolidated seed defaults for settings, driver event settings, cronjobs,
-- and vehicle efficiency lookup. All use ON CONFLICT DO NOTHING so they are
-- safe to run on databases that already have these rows from earlier migrations.

-- Sequences not managed by Drizzle ORM
CREATE SEQUENCE IF NOT EXISTS support_case_number_seq START WITH 1000;
CREATE SEQUENCE IF NOT EXISTS ocpp16_transaction_id_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1;

-- Default roles
INSERT INTO roles (id, name, description) VALUES
  ('rol_000000000001', 'admin', 'Full system access'),
  ('rol_000000000002', 'operator', 'Operational access'),
  ('rol_000000000003', 'viewer', 'Read-only access')
ON CONFLICT (name) DO NOTHING;

-- Settings (all keys matching Helm values.yaml appSettings defaults)
INSERT INTO settings (key, value) VALUES
  -- System
  ('system.name', '"EVtivity CSMS"'),
  ('system.timezone', '"America/New_York"'),
  -- OCPP
  ('ocpp.heartbeat_interval', '300'),
  ('ocpp.meter_value_interval', '60'),
  ('ocpp.clock_aligned_interval', '60'),
  ('ocpp.sampled_measurands', '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'),
  ('ocpp.aligned_measurands', '"Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import"'),
  ('ocpp.tx_ended_measurands', '"Energy.Active.Import.Register"'),
  ('ocpp.connection_timeout', '120'),
  ('ocpp.reset_retries', '3'),
  ('ocpp.offline_command_ttl_hours', '24'),
  ('ocpp.registration_policy', '"approval-required"'),
  ('ocpp.commandRetryMaxAttempts', '3'),
  ('ocpp.commandRetryBaseDelayMs', '1000'),
  ('ocpp.commandRetryMaxDelayMs', '30000'),
  -- Security
  ('security.autoDisableOnCritical', 'true'::jsonb),
  ('security.recaptcha.enabled', 'false'::jsonb),
  ('security.recaptcha.siteKey', '""'),
  ('security.recaptcha.secretKeyEnc', '""'),
  ('security.recaptcha.threshold', '0.5'),
  ('security.mfa.emailEnabled', 'true'::jsonb),
  ('security.mfa.totpEnabled', 'true'::jsonb),
  ('security.mfa.smsEnabled', 'false'::jsonb),
  -- Company
  ('company.name', '"EVtivity"'),
  ('company.currency', '"USD"'),
  ('company.contactEmail', '"contact@evtivity.local"'),
  ('company.supportEmail', '"support@evtivity.local"'),
  ('company.supportPhone', '"+1 (555) 123-4567"'),
  ('company.street', '"100 Market Street"'),
  ('company.city', '"San Francisco"'),
  ('company.state', '"CA"'),
  ('company.zip', '"94105"'),
  ('company.country', '"US"'),
  ('company.metaDescription', '"EV charging station management"'),
  ('company.metaKeywords', '"EV, charging, OCPP"'),
  ('company.ogImage', '""'),
  ('company.portalUrl', '""'),
  ('company.themeColor', '"#2563eb"'),
  ('company.logo', '"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzE2YTM0YSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjExIiBmaWxsPSIjZjBmZGY0IiBzdHJva2U9IiMxNmEzNGEiIHN0cm9rZS13aWR0aD0iMSIvPjxwYXRoIGQ9Ik0xMyAyTDMgMTRoOWwtMSA4IDEwLTEyaC05bDEtOHoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEuNSAxKSBzY2FsZSgwLjg1KSIgZmlsbD0iIzE2YTM0YSIgc3Ryb2tlPSIjMTZhMzRhIi8+PC9zdmc+"'),
  -- Pricing
  ('pricing.currency', '"USD"'),
  ('pricing.splitBillingEnabled', 'true'),
  ('pricing.displayFormat', '"standard"'),
  ('pricing.pushDisplayEnabled', 'true'),
  -- Idling and sessions
  ('idling.gracePeriodMinutes', '30'),
  ('session.staleTimeoutHours', '24'),
  -- Notifications
  ('notifications.emailEnabled', 'true'),
  -- SMTP
  ('smtp.host', '""'),
  ('smtp.port', '""'),
  ('smtp.username', '""'),
  ('smtp.password', '""'),
  ('smtp.from', '""'),
  -- Twilio
  ('twilio.accountSid', '""'),
  ('twilio.authToken', '""'),
  ('twilio.fromNumber', '""'),
  -- S3
  ('s3.bucket', '""'),
  ('s3.region', '""'),
  ('s3.accessKeyId', '""'),
  ('s3.secretAccessKeyEnc', '""'),
  -- Stripe
  ('stripe.secretKeyEnc', '""'),
  ('stripe.publishableKey', '""'),
  ('stripe.currency', '"USD"'),
  ('stripe.preAuthAmountCents', '5000'),
  ('stripe.platformFeePercent', '0'),
  -- FTP
  ('ftp.host', '""'),
  ('ftp.port', '"21"'),
  ('ftp.username', '""'),
  ('ftp.password', '""'),
  ('ftp.path', '""'),
  -- Feature toggles
  ('roaming.enabled', 'false'::jsonb),
  ('reservation.enabled', 'true'::jsonb),
  ('reservation.bufferMinutes', '0'),
  ('reservation.cancellationWindowMinutes', '0'),
  ('reservation.cancellationFeeCents', '0'),
  ('fleet.enabled', 'true'::jsonb),
  ('support.enabled', 'true'::jsonb),
  ('guest.enabled', 'true'::jsonb),
  -- PnC
  ('pnc.enabled', 'false'::jsonb),
  ('pnc.provider', '"manual"'),
  ('pnc.hubject.baseUrl', '""'),
  ('pnc.hubject.clientId', '""'),
  ('pnc.hubject.clientSecretEnc', '""'),
  ('pnc.hubject.tokenUrl', '""'),
  ('pnc.expirationWarningDays', '30'),
  ('pnc.expirationCriticalDays', '7'),
  -- Smart charging
  ('smartCharging.iso15118Enabled', 'true'::jsonb),
  ('smartCharging.defaultMaxPowerW', '22000'),
  -- Sentry
  ('sentry.enabled', 'false'::jsonb),
  ('sentry.dsn', '""'),
  ('sentry.environment', '"production"'),
  -- Sustainability
  ('sustainability.gridEmissionFactor', '"0.386"'),
  ('sustainability.evEfficiency', '"3.3"'),
  ('sustainability.gasolineEmissionFactor', '"8.887"'),
  ('sustainability.avgMpg', '"25.4"'),
  -- Google Maps
  ('googleMaps.apiKey', '""'),
  ('googleMaps.defaultLat', '"39.8283"'),
  ('googleMaps.defaultLng', '"-98.5795"'),
  ('googleMaps.defaultZoom', '"4"'),
  -- Chatbot AI
  ('chatbotAi.enabled', 'false'::jsonb),
  ('chatbotAi.provider', '"anthropic"'),
  ('chatbotAi.apiKeyEnc', '""'),
  ('chatbotAi.model', '""'),
  ('chatbotAi.temperature', '""'),
  ('chatbotAi.topP', '""'),
  ('chatbotAi.topK', '""'),
  ('chatbotAi.systemPrompt', '""'),
  -- Support AI
  ('supportAi.enabled', 'true'::jsonb),
  ('supportAi.provider', '""'),
  ('supportAi.apiKeyEnc', '""'),
  ('supportAi.model', '""'),
  ('supportAi.temperature', '""'),
  ('supportAi.topP', '""'),
  ('supportAi.topK', '""'),
  ('supportAi.systemPrompt', '""'),
  ('supportAi.tone', '"professional"'),
  -- SSO
  ('sso.enabled', 'false'::jsonb),
  ('sso.provider', '""'),
  ('sso.entryPoint', '""'),
  ('sso.issuer', '"evtivity-csms"'),
  ('sso.cert', '""'),
  ('sso.autoProvision', 'false'::jsonb),
  ('sso.defaultRoleId', '""'),
  ('sso.attributeMapping', '{"email":"email","firstName":"firstName","lastName":"lastName"}')
ON CONFLICT (key) DO NOTHING;

-- Driver event settings
INSERT INTO driver_event_settings (event_type, is_enabled) VALUES
  ('session.IdlingStarted', true),
  ('connector.Available', false)
ON CONFLICT (event_type) DO NOTHING;

-- Cron jobs
INSERT INTO cronjobs (name, schedule, status, next_run_at) VALUES
  ('tariff-boundary-check', '* * * * *', 'pending', now()),
  ('guest-session-cleanup', '*/5 * * * *', 'pending', now())
ON CONFLICT DO NOTHING;

-- Vehicle efficiency lookup (common EV models)
INSERT INTO vehicle_efficiency_lookup (make, model, efficiency_mi_per_kwh) VALUES
  ('Tesla', 'Model 3', 4.0),
  ('Tesla', 'Model Y', 3.5),
  ('Tesla', 'Model S', 3.3),
  ('Tesla', 'Model X', 2.9),
  ('Chevrolet', 'Bolt EV', 3.9),
  ('Chevrolet', 'Bolt EUV', 3.6),
  ('Chevrolet', 'Equinox EV', 3.3),
  ('Nissan', 'Leaf', 3.5),
  ('Nissan', 'Ariya', 3.2),
  ('Ford', 'Mustang Mach-E', 3.0),
  ('Ford', 'F-150 Lightning', 2.2),
  ('Hyundai', 'Ioniq 5', 3.4),
  ('Hyundai', 'Ioniq 6', 4.0),
  ('Kia', 'EV6', 3.4),
  ('Kia', 'EV9', 2.6),
  ('BMW', 'iX', 2.8),
  ('BMW', 'i4', 3.5),
  ('Rivian', 'R1T', 2.3),
  ('Rivian', 'R1S', 2.3),
  ('Volkswagen', 'ID.4', 3.2),
  ('Mercedes-Benz', 'EQS', 3.2),
  ('Porsche', 'Taycan', 2.8),
  ('Lucid', 'Air', 4.6),
  ('Polestar', '2', 3.3)
ON CONFLICT DO NOTHING;

-- Pricing Groups (6 rows)
INSERT INTO pricing_groups (id, name, description, is_default) VALUES
  ('pgr_seed00000001', 'Time-of-Day Standard', 'Full schedule with peak/off-peak/shoulder/holiday/energy tiers', true),
  ('pgr_seed00000002', 'Premium DC Fast', 'High-power DC with weekday/weekend time splits', false),
  ('pgr_seed00000003', 'Fleet Discount', 'Discounted fleet rate with seasonal and energy tiers', false),
  ('pgr_seed00000004', 'Employee Benefit', 'Free off-peak charging with nominal peak rate', false),
  ('pgr_seed00000005', 'Seasonal Resort', 'Summer/winter seasonal pricing for resort locations', false),
  ('pgr_seed00000006', 'VIP', 'Free charging for VIP drivers', false)
ON CONFLICT (id) DO NOTHING;

-- Tariffs (31 rows)
INSERT INTO tariffs (id, pricing_group_id, name, currency, price_per_kwh, price_per_minute, price_per_session, idle_fee_price_per_minute, tax_rate, is_active, priority, is_default, restrictions) VALUES
  -- Group 1: Time-of-Day Standard
  ('trf_seed00000001', 'pgr_seed00000001', 'Standard Rate', 'USD', 0.30, 0.02, 1.00, 0.15, 0.0825, true, 0, true, NULL),
  ('trf_seed00000002', 'pgr_seed00000001', 'Peak Hours', 'USD', 0.48, 0.05, 1.50, 0.25, 0.0825, true, 10, false, '{"timeRange":{"startTime":"16:00","endTime":"21:00"}}'::jsonb),
  ('trf_seed00000003', 'pgr_seed00000001', 'Off-Peak Overnight', 'USD', 0.18, 0.00, 0.50, 0.00, 0.0825, true, 10, false, '{"timeRange":{"startTime":"23:00","endTime":"06:00"}}'::jsonb),
  ('trf_seed00000004', 'pgr_seed00000001', 'Weekday Business Hours', 'USD', 0.42, 0.04, 1.25, 0.20, 0.0825, true, 20, false, '{"daysOfWeek":[1,2,3,4,5],"timeRange":{"startTime":"08:00","endTime":"17:00"}}'::jsonb),
  ('trf_seed00000005', 'pgr_seed00000001', 'Weekend Daytime', 'USD', 0.25, 0.01, 0.75, 0.10, 0.0825, true, 20, false, '{"daysOfWeek":[0,6],"timeRange":{"startTime":"09:00","endTime":"21:00"}}'::jsonb),
  ('trf_seed00000006', 'pgr_seed00000001', 'Holiday Rate', 'USD', 0.22, 0.01, 0.50, 0.00, 0.0825, true, 40, false, '{"holidays":true}'::jsonb),
  ('trf_seed00000007', 'pgr_seed00000001', 'High Usage Surcharge', 'USD', 0.55, 0.06, 2.00, 0.30, 0.0825, true, 50, false, '{"energyThresholdKwh":80}'::jsonb),
  -- Group 2: Premium DC Fast
  ('trf_seed00000008', 'pgr_seed00000002', 'DC Base Rate', 'USD', 0.50, 0.08, 2.00, 0.40, 0.0725, true, 0, true, NULL),
  ('trf_seed00000009', 'pgr_seed00000002', 'Weekday Morning Rush', 'USD', 0.65, 0.10, 2.50, 0.50, 0.0725, true, 20, false, '{"daysOfWeek":[1,2,3,4,5],"timeRange":{"startTime":"07:00","endTime":"10:00"}}'::jsonb),
  ('trf_seed00000010', 'pgr_seed00000002', 'Weekday Evening Rush', 'USD', 0.68, 0.10, 2.50, 0.50, 0.0725, true, 20, false, '{"daysOfWeek":[1,2,3,4,5],"timeRange":{"startTime":"17:00","endTime":"20:00"}}'::jsonb),
  ('trf_seed00000011', 'pgr_seed00000002', 'Weekend Rate', 'USD', 0.45, 0.06, 1.50, 0.30, 0.0725, true, 20, false, '{"daysOfWeek":[0,6],"timeRange":{"startTime":"06:00","endTime":"22:00"}}'::jsonb),
  ('trf_seed00000012', 'pgr_seed00000002', 'Holiday Discount', 'USD', 0.40, 0.04, 1.00, 0.20, 0.0725, true, 40, false, '{"holidays":true}'::jsonb),
  ('trf_seed00000013', 'pgr_seed00000002', 'Ultra-High Usage', 'USD', 0.75, 0.12, 3.00, 0.60, 0.0725, true, 50, false, '{"energyThresholdKwh":100}'::jsonb),
  -- Group 3: Fleet Discount
  ('trf_seed00000014', 'pgr_seed00000003', 'Fleet Base Rate', 'USD', 0.20, 0.00, 0.00, NULL, 0.0825, true, 0, true, NULL),
  ('trf_seed00000015', 'pgr_seed00000003', 'Fleet Overnight', 'USD', 0.12, 0.00, 0.00, NULL, 0.0825, true, 10, false, '{"timeRange":{"startTime":"22:00","endTime":"05:00"}}'::jsonb),
  ('trf_seed00000016', 'pgr_seed00000003', 'Summer Peak Surcharge', 'USD', 0.28, 0.02, 0.50, NULL, 0.0825, true, 30, false, '{"dateRange":{"startDate":"06-01","endDate":"09-30"}}'::jsonb),
  ('trf_seed00000017', 'pgr_seed00000003', 'Winter Discount', 'USD', 0.14, 0.00, 0.00, NULL, 0.0825, true, 30, false, '{"dateRange":{"startDate":"11-01","endDate":"02-28"}}'::jsonb),
  ('trf_seed00000018', 'pgr_seed00000003', 'Fleet Bulk Discount', 'USD', 0.10, 0.00, 0.00, NULL, 0.0825, true, 50, false, '{"energyThresholdKwh":50}'::jsonb),
  -- Group 4: Employee Benefit
  ('trf_seed00000019', 'pgr_seed00000004', 'Employee Free Charging', 'USD', 0.00, 0.00, 0.00, 0.10, 0.00, true, 0, true, NULL),
  ('trf_seed00000020', 'pgr_seed00000004', 'Employee Peak Rate', 'USD', 0.10, 0.01, 0.00, 0.15, 0.00, true, 10, false, '{"timeRange":{"startTime":"12:00","endTime":"14:00"}}'::jsonb),
  ('trf_seed00000021', 'pgr_seed00000004', 'Friday Afternoon Free', 'USD', 0.00, 0.00, 0.00, 0.00, 0.00, true, 20, false, '{"daysOfWeek":[5],"timeRange":{"startTime":"13:00","endTime":"18:00"}}'::jsonb),
  ('trf_seed00000022', 'pgr_seed00000004', 'Holiday Free Charging', 'USD', 0.00, 0.00, 0.00, 0.00, 0.00, true, 40, false, '{"holidays":true}'::jsonb),
  -- Group 5: Seasonal Resort
  ('trf_seed00000023', 'pgr_seed00000005', 'Resort Base Rate', 'USD', 0.35, 0.03, 1.50, 0.20, 0.09, true, 0, true, NULL),
  ('trf_seed00000024', 'pgr_seed00000005', 'Evening Discount', 'USD', 0.25, 0.01, 0.75, 0.10, 0.09, true, 10, false, '{"timeRange":{"startTime":"20:00","endTime":"08:00"}}'::jsonb),
  ('trf_seed00000025', 'pgr_seed00000005', 'Summer Peak Season', 'USD', 0.55, 0.06, 2.50, 0.35, 0.09, true, 30, false, '{"dateRange":{"startDate":"05-15","endDate":"09-15"}}'::jsonb),
  ('trf_seed00000026', 'pgr_seed00000005', 'Ski Season Premium', 'USD', 0.50, 0.05, 2.00, 0.30, 0.09, true, 30, false, '{"dateRange":{"startDate":"11-15","endDate":"03-31"}}'::jsonb),
  ('trf_seed00000027', 'pgr_seed00000005', 'Holiday Premium', 'USD', 0.60, 0.08, 3.00, 0.50, 0.09, true, 40, false, '{"holidays":true}'::jsonb),
  ('trf_seed00000028', 'pgr_seed00000005', 'Heavy Usage Rate', 'USD', 0.70, 0.10, 3.50, 0.50, 0.09, true, 50, false, '{"energyThresholdKwh":60}'::jsonb),
  -- Group 6: VIP
  ('trf_seed00000029', 'pgr_seed00000006', 'VIP Free Charging', 'USD', 0.00, 0.00, 0.00, 0.00, 0.00, true, 0, true, NULL)
ON CONFLICT (id) DO NOTHING;



-- Default site and stations for fresh installations
INSERT INTO sites (id, name, address, city, state, postal_code, country, latitude, longitude, timezone)
VALUES ('sit_000000000001', 'Main Office', '100 Main St', 'New York', 'NY', '10001', 'US', '40.750000', '-73.997000', 'America/New_York')
ON CONFLICT (id) DO NOTHING;

INSERT INTO vendors (id, name)
VALUES ('vnd_000000000001', 'EVtivity')
ON CONFLICT (id) DO NOTHING;

INSERT INTO charging_stations (id, station_id, vendor_id, site_id, model, ocpp_protocol, security_profile)
VALUES
  ('sta_000000000001', 'CS-0001', 'vnd_000000000001', 'sit_000000000001', 'EVtivity AC', 'ocpp1.6', 0),
  ('sta_000000000002', 'CS-0002', 'vnd_000000000001', 'sit_000000000001', 'EVtivity DC', 'ocpp2.1', 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evses (id, station_id, evse_id)
VALUES
  ('evs_000000000001', 'sta_000000000001', 1),
  ('evs_000000000002', 'sta_000000000002', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO connectors (id, evse_id, connector_id, connector_type, max_power_kw, status)
VALUES
  ('con_000000000001', 'evs_000000000001', 1, 'Type2', 22.0, 'available'),
  ('con_000000000002', 'evs_000000000002', 1, 'CCS2', 150.0, 'available')
ON CONFLICT (id) DO NOTHING;
