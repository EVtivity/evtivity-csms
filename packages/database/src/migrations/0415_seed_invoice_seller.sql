-- Invoice seller details printed in the "From" block of invoice and credit
-- note PDFs next to company.name and the company address: the tax ID, its
-- label ('' prints the localized "Tax ID" label), the company registration
-- number, and the contact email and phone for invoices. Every value starts
-- empty, and an empty value is left out of the PDF.
-- ON CONFLICT DO NOTHING keeps an operator value; idempotent.

INSERT INTO "settings" ("key", "value") VALUES
  ('company.taxId', '""'::jsonb),
  ('company.taxIdLabel', '""'::jsonb),
  ('company.registrationNumber', '""'::jsonb),
  ('company.invoiceEmail', '""'::jsonb),
  ('company.invoicePhone', '""'::jsonb)
ON CONFLICT ("key") DO NOTHING;
