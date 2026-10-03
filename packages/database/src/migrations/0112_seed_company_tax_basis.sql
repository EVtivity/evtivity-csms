-- Whether tariff prices are entered excluding ('net') or including ('gross')
-- tax. Net by default, so existing installations keep their prices and
-- charge the same amounts.

INSERT INTO settings (key, value) VALUES ('company.taxBasis', '"net"'::jsonb) ON CONFLICT (key) DO NOTHING;
