// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

export async function chargingProfileReconciliationHandler(log: Logger): Promise<void> {
  const { chargingProfiles } = await import('@evtivity/database');

  // Get stations that have csms_set profiles
  const stationsWithProfiles = await db
    .selectDistinct({ stationId: chargingProfiles.stationId })
    .from(chargingProfiles)
    .where(eq(chargingProfiles.source, 'csms_set'));

  let mismatchCount = 0;

  for (const row of stationsWithProfiles) {
    // Get latest CSMS-set profiles grouped by evseId
    const csmsProfiles = await db
      .select({
        evseId: chargingProfiles.evseId,
        profileData: chargingProfiles.profileData,
      })
      .from(chargingProfiles)
      .where(
        and(eq(chargingProfiles.stationId, row.stationId), eq(chargingProfiles.source, 'csms_set')),
      )
      .orderBy(sql`${chargingProfiles.sentAt} DESC NULLS LAST`);

    // Get latest station-reported profiles grouped by evseId
    const stationProfiles = await db
      .select({
        evseId: chargingProfiles.evseId,
        profileData: chargingProfiles.profileData,
      })
      .from(chargingProfiles)
      .where(
        and(
          eq(chargingProfiles.stationId, row.stationId),
          eq(chargingProfiles.source, 'station_reported'),
        ),
      )
      .orderBy(sql`${chargingProfiles.reportedAt} DESC NULLS LAST`);

    // Build maps of latest profile per evseId
    const csmsMap = new Map<number | null, unknown>();
    for (const p of csmsProfiles) {
      if (!csmsMap.has(p.evseId)) csmsMap.set(p.evseId, p.profileData);
    }

    const stationMap = new Map<number | null, unknown>();
    for (const p of stationProfiles) {
      if (!stationMap.has(p.evseId)) stationMap.set(p.evseId, p.profileData);
    }

    // Compare
    for (const [evseId, csmsData] of csmsMap) {
      const stationData = stationMap.get(evseId);
      if (stationData == null || JSON.stringify(csmsData) !== JSON.stringify(stationData)) {
        mismatchCount++;
        try {
          const pubsub = getPubSub();
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
