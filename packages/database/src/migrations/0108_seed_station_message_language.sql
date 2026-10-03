-- Display language of station messages: picks the template language and the
-- number, price, and tax rate format. English by default, so existing
-- installations keep their English screens.

INSERT INTO settings (key, value) VALUES ('stationMessage.language', '"en"'::jsonb) ON CONFLICT (key) DO NOTHING;
