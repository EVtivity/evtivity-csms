-- Whether the driver portal shows tariff prices including ('gross') or
-- excluding ('net') tax for drivers and guests who have not chosen. Net by
-- default, so existing installations keep showing net prices.

INSERT INTO settings (key, value) VALUES ('company.priceDisplay', '"net"'::jsonb) ON CONFLICT (key) DO NOTHING;
