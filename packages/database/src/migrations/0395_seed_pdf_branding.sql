-- PDF branding: the logo and the footer drawn on every PDF the platform
-- generates (invoices, credit notes, fleet invoices, reports).
-- pdf.logo is a PNG or SVG data URI; '' means the default EVtivity logo.
-- Invoices drew company.logo before, so an install whose company.logo is an
-- uploaded image (not one of the four logos the platform shipped as default)
-- keeps it on its PDFs. pdf.footer is plain text centered at the bottom of
-- every page, 'www.evtivity.com' by default; '' means no footer. The footer
-- is filled only when it is unset or empty, so a saved footer stays.
-- ON CONFLICT DO NOTHING keeps an operator logo; idempotent.

INSERT INTO "settings" ("key", "value")
SELECT 'pdf.logo', COALESCE(
  (
    SELECT "value" FROM "settings"
    WHERE "key" = 'company.logo'
      AND jsonb_typeof("value") = 'string'
      AND ("value" #>> '{}') ~ '^data:image/(png|jpeg|jpg|svg\+xml)[;,]'
      AND "value" NOT IN (
      '"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAgMTIwIiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCI+PGRlZnM+PG1hc2sgaWQ9ImxvZ29SaW5nR2FwcyI+PHJlY3Qgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxMjAiIGZpbGw9IndoaXRlIi8+PHBvbHlnb24gcG9pbnRzPSI2OC44MiwtOC4yNCA3Ni43MCwtNi44NiA2OS44MiwzMi41NCA2MS45NCwzMS4xNiIgZmlsbD0iYmxhY2siLz48cG9seWdvbiBwb2ludHM9IjUyLjA4LDg3LjQ2IDU5Ljk2LDg4Ljg0IDUzLjA4LDEyOC4yNCA0NS4yMCwxMjYuODYiIGZpbGw9ImJsYWNrIi8+PC9tYXNrPjxzdHlsZT5Aa2V5ZnJhbWVzIGV2dGl2aXR5LWxvZ28tc3BpbnswJXt0cmFuc2Zvcm06cm90YXRlKDBkZWcpfTEyJXt0cmFuc2Zvcm06cm90YXRlKDM2MGRlZyl9MTAwJXt0cmFuc2Zvcm06cm90YXRlKDM2MGRlZyl9fUBrZXlmcmFtZXMgZXZ0aXZpdHktbG9nby1wdWxzZXswJSwxMDAle2ZpbGw6IzIyYzU1ZTt0cmFuc2Zvcm06c2NhbGUoMC45NSk7ZmlsdGVyOmRyb3Atc2hhZG93KDAgMCAwIHJnYmEoMzQsMTk3LDk0LDApKX01MCV7ZmlsbDojMTZhMzRhO3RyYW5zZm9ybTpzY2FsZSgwLjkpO2ZpbHRlcjpkcm9wLXNoYWRvdygwIDAgNnB4IHJnYmEoMzQsMTk3LDk0LDAuNykpfX0uZXZ0aXZpdHktbG9nby1yaW5ne3RyYW5zZm9ybS1vcmlnaW46NjBweCA2MHB4O2FuaW1hdGlvbjpldnRpdml0eS1sb2dvLXNwaW4gMTBzIGVhc2UtaW4tb3V0IGluZmluaXRlfS5ldnRpdml0eS1sb2dvLWJvbHR7dHJhbnNmb3JtLW9yaWdpbjo2MHB4IDYwcHg7dHJhbnNmb3JtOnNjYWxlKDAuOTUpO2ZpbGw6IzIyYzU1ZTthbmltYXRpb246ZXZ0aXZpdHktbG9nby1wdWxzZSA1cyBlYXNlLWluLW91dCBpbmZpbml0ZX1AbWVkaWEgKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsuZXZ0aXZpdHktbG9nby1yaW5ne2FuaW1hdGlvbjpub25lfS5ldnRpdml0eS1sb2dvLWJvbHR7YW5pbWF0aW9uOm5vbmV9fTwvc3R5bGU+PC9kZWZzPjxnIGNsYXNzPSJldnRpdml0eS1sb2dvLXJpbmciPjxjaXJjbGUgY3g9IjYwIiBjeT0iNjAiIHI9IjUwIiBmaWxsPSJub25lIiBzdHJva2U9IiMyMmM1NWUiIHN0cm9rZS13aWR0aD0iMTIiIG1hc2s9InVybCgjbG9nb1JpbmdHYXBzKSIvPjwvZz48cGF0aCBjbGFzcz0iZXZ0aXZpdHktbG9nby1ib2x0IiBkPSJNNjggMjBMMzggNjhoMjJsLTYgMzIgMzAtNDhINjJsNi0zMnoiLz48L3N2Zz4="',
      '"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAgMTIwIiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCI+PGRlZnM+PG1hc2sgaWQ9InJpbmdnYXBzIj48cmVjdCB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgZmlsbD0id2hpdGUiLz48cG9seWdvbiBwb2ludHM9IjY4LjgyLC04LjI0IDc2LjcwLC02Ljg2IDY5LjgyLDMyLjU0IDYxLjk0LDMxLjE2IiBmaWxsPSJibGFjayIvPjxwb2x5Z29uIHBvaW50cz0iNTIuMDgsODcuNDYgNTkuOTYsODguODQgNTMuMDgsMTI4LjI0IDQ1LjIwLDEyNi44NiIgZmlsbD0iYmxhY2siLz48L21hc2s+PC9kZWZzPjxjaXJjbGUgY3g9IjYwIiBjeT0iNjAiIHI9IjUwIiBmaWxsPSJub25lIiBzdHJva2U9IiMyMmM1NWUiIHN0cm9rZS13aWR0aD0iMTIiIG1hc2s9InVybCgjcmluZ2dhcHMpIi8+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNjAgNjApIHNjYWxlKDAuOTUpIHRyYW5zbGF0ZSgtNjAgLTYwKSI+PHBhdGggZD0iTTY4IDIwTDM4IDY4aDIybC02IDMyIDMwLTQ4SDYybDYtMzJ6IiBmaWxsPSIjMjJjNTVlIi8+PC9nPjwvc3ZnPg=="',
      '"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMTIwIDEyMCI+PGNpcmNsZSBjeD0iNjAiIGN5PSI2MCIgcj0iNTYiIGZpbGw9IiM0YWRlODAiLz48cGF0aCBkPSJNNjggMjBMMzggNjhoMjJsLTYgMzIgMzAtNDhINjJsNi0zMnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+"',
      '"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzE2YTM0YSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjExIiBmaWxsPSIjZjBmZGY0IiBzdHJva2U9IiMxNmEzNGEiIHN0cm9rZS13aWR0aD0iMSIvPjxwYXRoIGQ9Ik0xMyAyTDMgMTRoOWwtMSA4IDEwLTEyaC05bDEtOHoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEuNSAxKSBzY2FsZSgwLjg1KSIgZmlsbD0iIzE2YTM0YSIgc3Ryb2tlPSIjMTZhMzRhIi8+PC9zdmc+"'
      )
  ),
  '""'::jsonb
)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES ('pdf.footer', '"www.evtivity.com"'::jsonb)
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now()
WHERE "settings"."value" = '""'::jsonb OR "settings"."value" = 'null'::jsonb;
