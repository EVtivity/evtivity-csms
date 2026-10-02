-- NotifyWebPaymentStarted is sent by the CSMS to the station, and NotifyQRCodeScanned is not an
-- OCPP 2.1 message, so nothing writes these station-message tables any more.
DROP TABLE IF EXISTS web_payment_events;
--> statement-breakpoint
DROP TABLE IF EXISTS qr_scan_events;
