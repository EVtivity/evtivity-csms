-- v0.1.49 company branding: the front plate colors of the AC and DC chargers
-- in the 3D site layout. Empty uses the brand color (company.themeColor).
-- Added after the release file shipped in a prerelease, so it is its own file.
INSERT INTO "settings" ("key", "value") VALUES
  ('company.chargerColorAc', '""'::jsonb),
  ('company.chargerColorDc', '""'::jsonb)
ON CONFLICT ("key") DO NOTHING;
