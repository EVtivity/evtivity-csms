-- Shift the dashboard-snapshot cron from 01:00 UTC to 11:00 UTC.
--
-- Why: the worker computes "yesterday in each site's timezone" using
-- `now() AT TIME ZONE site_tz - interval '1 day'`. At 01:00 UTC the clock
-- is still on yesterday's local date for sites in the Americas (PT = 17:00
-- previous day; ET = 20:00 previous day), so the snapshot it produces is
-- two calendar days behind the operator's "yesterday" view in the dashboard
-- UI. The frontend's Historical mode defaults to "yesterday in the
-- operator's local timezone" and then shows the No Data overlay because
-- no row matches.
--
-- 11:00 UTC is past local midnight everywhere from UTC-11 to UTC+12
-- (i.e. every populated business timezone except a handful of mid-Pacific
-- islands), so every site's "yesterday in site_tz" calculation produces
-- the calendar date that the operator UI is asking for.
--
-- We update the next_run_at to a time in the near future so the catch-up
-- run happens promptly, then subsequent runs follow the new schedule.

UPDATE cronjobs
SET schedule = '0 11 * * *',
    next_run_at = LEAST(next_run_at, NOW() + INTERVAL '5 minutes')
WHERE name = 'dashboard-snapshot';
