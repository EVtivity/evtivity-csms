// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  OCPI_REMOVED_EVSE_RETENTION_DAYS,
  ocpiLocationPublish,
  operatorStationSql,
  sites,
} from '@evtivity/database';

/**
 * A published location's `last_updated` in SQL, for the `date_from` and
 * `date_to` filters and the sort of `GET /cpo/locations` (OCPI 8.3.1:
 * "Timestamp when this Location or one of its EVSEs or Connectors were last
 * updated"). It reads the same inputs as `locationLastUpdated` in the
 * transformer: the site, its publish row, each EVSE of a station that is not
 * pending (conformance test stations excluded, they are never published) with
 * its station and every connector, and each removed EVSE still
 * served as REMOVED. Use it in a query that joins `sites` and
 * `ocpi_location_publish`.
 */
export function locationLastUpdatedSql(): SQL<Date> {
  return sql<Date>`GREATEST(
    ${sites.updatedAt},
    ${ocpiLocationPublish.updatedAt},
    (SELECT max(GREATEST(e.updated_at, cs.updated_at,
        (SELECT max(c.updated_at) FROM connectors c WHERE c.evse_id = e.id)))
       FROM evses e JOIN charging_stations cs ON cs.id = e.station_id
      WHERE cs.site_id = ${sites.id} AND cs.onboarding_status <> 'pending'
        AND ${sql.raw(operatorStationSql('cs'))}),
    (SELECT max(r.removed_at) FROM ocpi_removed_evses r
      WHERE r.site_id = ${sites.id}
        AND r.removed_at >= now() - make_interval(days => ${OCPI_REMOVED_EVSE_RETENTION_DAYS})
        AND NOT EXISTS (
          SELECT 1 FROM evses e2 JOIN charging_stations cs2 ON cs2.id = e2.station_id
           WHERE e2.id = r.evse_uid AND cs2.site_id = r.site_id))
  )`;
}
