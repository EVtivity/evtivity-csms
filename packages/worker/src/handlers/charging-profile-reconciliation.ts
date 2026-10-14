// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray, sql } from 'drizzle-orm';
import { db, chargingProfiles, chargingStations } from '@evtivity/database';
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

  // The station's site, so the operator SSE stream delivers the mismatch
  // event to operators of that site only, and its protocol.
  const stationSites = await db
    .select({
      id: chargingStations.id,
      siteId: chargingStations.siteId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(inArray(chargingStations.id, stationIds));
  const siteByStation = new Map(stationSites.map((s) => [s.id, s.siteId]));
  const protocolByStation = new Map(stationSites.map((s) => [s.id, s.ocppProtocol]));

  const pubsub = getPubSub();
  let mismatchCount = 0;

  for (const row of stationsWithProfiles) {
    // OCPP 1.6 has no GetChargingProfiles, so there is no station report to
    // compare with.
    if (protocolByStation.get(row.stationId) === 'ocpp1.6') continue;

    // A csms_set row holds one profile, a station_reported row the array of
    // one report. The profile id identifies a profile on the station, so a
    // profile the CSMS set is in sync when the station reports that id (the
    // station's own rendering of the fields need not match byte for byte).
    const reportedIds = new Set<number>();
    for (const p of reportedRows) {
      if (p.stationId !== row.stationId) continue;
      for (const profile of profileList(p.profileData)) {
        const id = profileId(profile);
        if (id != null) reportedIds.add(id);
      }
    }
    const missing = csmsRows.some((p) => {
      if (p.stationId !== row.stationId) return false;
      const id = profileId(p.profileData);
      return id != null && !reportedIds.has(id);
    });
    if (!missing) continue;

    mismatchCount++;
    try {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({
          eventType: 'station.profileMismatch',
          stationId: row.stationId,
          sessionId: null,
          siteId: siteByStation.get(row.stationId) ?? null,
        }),
      );
    } catch (err) {
      log.warn(
        { err, stationId: row.stationId },
        'Profile mismatch event publish failed, the dashboard is not notified',
      );
    }
  }

  if (mismatchCount > 0) {
    log.info({ mismatchCount }, 'Charging profile mismatches detected');
  }
}

function profileList(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [data];
}

/** The OCPP profile id: `id` (2.1) or `chargingProfileId` (a profile stored in 1.6 form). */
function profileId(profile: unknown): number | null {
  if (profile == null || typeof profile !== 'object') return null;
  const record = profile as Record<string, unknown>;
  const raw = record['id'] ?? record['chargingProfileId'];
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}
