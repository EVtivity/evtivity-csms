-- Per-partner "private network" flag for the OCPI SSRF guard. Off (the
-- default): outbound OCPI requests and command callbacks reach public
-- addresses only. On: loopback and private addresses are allowed too.
--
-- Partners already configured with a URL that can only be private (localhost,
-- a loopback or RFC 1918 IP literal, an IPv6 literal, or a single-label
-- Docker-style host such as ocpi-simulator) get the flag, so a working
-- private peering or local simulator keeps working after the upgrade.
ALTER TABLE "ocpi_partners" ADD COLUMN IF NOT EXISTS "allow_private_network" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
WITH partner_hosts AS (
  SELECT p.id, lower(substring(u.url FROM '^[a-zA-Z]+://(?:[^@/]*@)?(\[[^]]*\]|[^/:?#]+)')) AS host
  FROM "ocpi_partners" p
  CROSS JOIN LATERAL (
    SELECT p.version_url AS url
    UNION ALL
    SELECT e.url FROM "ocpi_partner_endpoints" e WHERE e.partner_id = p.id
  ) u
  WHERE u.url IS NOT NULL
)
UPDATE "ocpi_partners" SET "allow_private_network" = true
WHERE "allow_private_network" = false
  AND id IN (
    SELECT id FROM partner_hosts
    WHERE host = 'localhost'
       OR host LIKE '[%'
       OR host ~ '^(127|10)\.'
       OR host ~ '^192\.168\.'
       OR host ~ '^172\.(1[6-9]|2[0-9]|3[01])\.'
       OR host !~ '\.'
  );
