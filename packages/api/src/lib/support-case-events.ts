// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  db,
  supportCaseSessions,
  supportCases,
} from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const logger = createLogger('support-case-events');

// Real-time fan-out for support-case state changes. Operators receive the
// event on csms_events with the same scope as supportCaseSiteCondition: a
// case at a station carries the station's siteId; a case without a station
// carries caseSiteIds, the sites of its linked sessions, or null when it has
// none or one ran at an unsited station (all-site operators only). The
// operator SSE stream (isEventVisible) delivers it to a site-restricted
// operator only when every one of those sites is its own. The owning driver also receives
// it on portal_events so the driver portal can refetch its case detail
// without polling.
//
// The portal SSE endpoint filters by driverId before broadcasting, so
// drivers only see events for cases they own. Pass driverId = null when the
// event should not reach the portal (e.g. internal operator notes, cases
// not linked to a driver).
//
// Callers fire and forget, after the case change committed. A failed lookup
// or publish only costs a live refresh, so it is logged at warn and never
// rejects (fail-open, design principle P9).
export async function notifySupportCaseEvent(
  eventType: 'supportCase.created' | 'supportCase.updated' | 'supportCase.newMessage',
  caseId: string,
  driverId: string | null,
): Promise<void> {
  try {
    await publishSupportCaseEvent(eventType, caseId, driverId);
  } catch (err) {
    logger.warn({ err, eventType, caseId }, 'Support case event not published');
  }
}

async function publishSupportCaseEvent(
  eventType: 'supportCase.created' | 'supportCase.updated' | 'supportCase.newMessage',
  caseId: string,
  driverId: string | null,
): Promise<void> {
  const pubsub = getPubSub();
  const [scope] = await db
    .select({ stationId: supportCases.stationId, siteId: chargingStations.siteId })
    .from(supportCases)
    .leftJoin(chargingStations, eq(chargingStations.id, supportCases.stationId))
    .where(eq(supportCases.id, caseId));
  const stationId = scope?.stationId ?? null;
  const caseSiteIds = stationId == null ? await linkedSessionSiteIds(caseId) : null;
  await pubsub.publish(
    'csms_events',
    JSON.stringify({
      eventType,
      caseId,
      stationId,
      siteId: scope?.siteId ?? null,
      caseSiteIds,
    }),
  );
  if (driverId != null) {
    await pubsub.publish('portal_events', JSON.stringify({ type: eventType, caseId, driverId }));
  }
}

/**
 * The distinct sites of the case's linked sessions, or null when the case has
 * no linked session or one ran at an unsited or deleted station.
 */
async function linkedSessionSiteIds(caseId: string): Promise<string[] | null> {
  const rows = await db
    .select({ siteId: chargingStations.siteId })
    .from(supportCaseSessions)
    .leftJoin(chargingSessions, eq(chargingSessions.id, supportCaseSessions.sessionId))
    .leftJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .where(eq(supportCaseSessions.caseId, caseId));
  if (rows.length === 0) return null;
  const siteIds = new Set<string>();
  for (const row of rows) {
    if (row.siteId == null) return null;
    siteIds.add(row.siteId);
  }
  return [...siteIds];
}
