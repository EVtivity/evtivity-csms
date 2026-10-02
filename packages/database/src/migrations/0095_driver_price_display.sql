-- Whether the driver portal shows prices including ('gross') or excluding
-- ('net') tax. Null follows the company setting company.priceDisplay.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "price_display" varchar(10);
