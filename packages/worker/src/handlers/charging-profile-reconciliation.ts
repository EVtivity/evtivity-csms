// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray, sql } from 'drizzle-orm';
import { db, chargingProfiles } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

export async function chargingProfileReconciliationHandler(log: Logger): Promise<void> {
  const stationsWithProfiles = await db
    .selectDistinct({ stationId: chargingProfiles.stationId })
    .from(chargingProfiles)
    .where(eq(chargingProfiles.source, 'csms_set'));

  if (stationsWithProfiles.length === 0) return;

  const stationIds = stationsWithProfiles.map((r) => r.stationId);

  // One query per source across all relevant stations; group by station in JS
  // instead of N queries per source per station.
  const csmsRows = await db
    .select({
      stationId: chargingProfiles.stationId,
      evseId: chargingProfiles.evseId,
      profileData: chargingProfiles.profileData,
    })
    .from(chargingProfiles)
    .where(
      and(inArray(chargingProfiles.stationId, stationIds), eq(chargingProfiles.source, 'csms_set')),
    )
    .orderBy(sql`${chargingProfiles.sentAt} DESC NULLS LAST`);

  const reportedRows = await db
    .select({
      stationId: chargingProfiles.stationId,
      evseId: chargingProfiles.evseId,
      profileData: chargingProfiles.profileData,
    })
    .from(chargingProfiles)
    .where(
      and(
        inArray(chargingProfiles.stationId, stationIds),
        eq(chargingProfiles.source, 'station_reported'),
      ),
    )
    .orderBy(sql`${chargingProfiles.reportedAt} DESC NULLS LAST`);

  const pubsub = getPubSub();
  let mismatchCount = 0;

  for (const row of stationsWithProfiles) {
    const csmsMap = new Map<number | null, unknown>();
    for (const p of csmsRows) {
      if (p.stationId !== row.stationId) continue;
      if (!csmsMap.has(p.evseId)) csmsMap.set(p.evseId, p.profileData);
    }

    const stationMap = new Map<number | null, unknown>();
    for (const p of reportedRows) {
      if (p.stationId !== row.stationId) continue;
      if (!stationMap.has(p.evseId)) stationMap.set(p.evseId, p.profileData);
    }

    for (const [evseId, csmsData] of csmsMap) {
      const stationData = stationMap.get(evseId);
      if (stationData == null || JSON.stringify(csmsData) !== JSON.stringify(stationData)) {
        mismatchCount++;
        try {
          await pubsub.publish(
            'csms_events',
            JSON.stringify({
              eventType: 'station.profileMismatch',
              stationId: row.stationId,
              sessionId: null,
              siteId: null,
            }),
          );
        } catch {
          // Best-effort SSE notification
        }
      }
    }
  }

  if (mismatchCount > 0) {
    log.info({ mismatchCount }, 'Charging profile mismatches detected');
  }
}
