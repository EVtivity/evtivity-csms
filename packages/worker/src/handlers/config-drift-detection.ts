// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray } from 'drizzle-orm';
import { db, chargingStations, configTemplates, stationConfigurations } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { findTemplateTargetConfiguration, configTemplateTarget } from '@evtivity/lib';

export async function configDriftDetectionHandler(log: Logger): Promise<void> {
  const templates = await db.select().from(configTemplates);
  const pubsub = getPubSub();

  let driftCount = 0;

  for (const template of templates) {
    const variables = template.variables as Array<{
      component: string;
      variable: string;
      value: string;
    }>;
    if (variables.length === 0) continue;

    // A template bound to a station targets that station only.
    const target = configTemplateTarget(template);
    const conditions = [eq(chargingStations.isOnline, true)];
    if (target.stationId != null) conditions.push(eq(chargingStations.id, target.stationId));
    if (target.siteId != null) conditions.push(eq(chargingStations.siteId, target.siteId));
    if (target.vendorId != null) conditions.push(eq(chargingStations.vendorId, target.vendorId));
    if (target.model != null) conditions.push(eq(chargingStations.model, target.model));

    const targetStations = await db
      .select({ id: chargingStations.id, siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(and(...conditions));

    if (targetStations.length === 0) continue;

    const stationIds = targetStations.map((s) => s.id);
    const allActualVars = await db
      .select()
      .from(stationConfigurations)
      .where(inArray(stationConfigurations.stationId, stationIds));

    const varsByStation = new Map<string, typeof allActualVars>();
    for (const v of allActualVars) {
      const list = varsByStation.get(v.stationId) ?? [];
      list.push(v);
      varsByStation.set(v.stationId, list);
    }

    for (const station of targetStations) {
      const actualVars = varsByStation.get(station.id) ?? [];
      for (const expected of variables) {
        const actual = findTemplateTargetConfiguration(
          actualVars,
          expected.component,
          expected.variable,
        );
        if (actual == null || actual.value !== expected.value) {
          driftCount++;
          try {
            await pubsub.publish(
              'csms_events',
              JSON.stringify({
                eventType: 'config.driftDetected',
                stationId: station.id,
                sessionId: null,
                siteId: station.siteId,
              }),
            );
          } catch (err) {
            log.warn(
              { err, stationId: station.id },
              'Config drift event publish failed, the dashboard is not notified',
            );
          }
          break;
        }
      }
    }
  }

  if (driftCount > 0) {
    log.info({ driftCount }, 'Configuration drift detected');
  }
}
