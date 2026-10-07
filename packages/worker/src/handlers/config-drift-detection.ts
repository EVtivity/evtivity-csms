// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray } from 'drizzle-orm';
import { db, chargingStations, configTemplates, stationConfigurations } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { findTemplateTargetConfiguration } from '@evtivity/lib';

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

    const filter = template.targetFilter as Record<string, string> | null;
    const conditions = [eq(chargingStations.isOnline, true)];
    if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
    if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
    if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

    const targetStations = await db
      .select({ id: chargingStations.id })
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
                siteId: null,
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
