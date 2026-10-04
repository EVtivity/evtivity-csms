-- Payments P10 Part E: the operator's mobile app builds. The API accepts a
-- 3D Secure return URL from the app only when it leads back to one of them:
-- an iOS custom URL scheme, or the Adyen Android SDK return URL
-- adyencheckout://<application id>. Defaults match the default brand of the
-- mobile app (scheme evtivity, application id com.evtivity.driver).
INSERT INTO settings (key, value) VALUES ('mobile.app.urlSchemes', '["evtivity"]'::jsonb) ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO settings (key, value) VALUES ('mobile.app.androidPackageNames', '["com.evtivity.driver"]'::jsonb) ON CONFLICT (key) DO NOTHING;
