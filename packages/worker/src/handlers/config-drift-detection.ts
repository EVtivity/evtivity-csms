// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, chargingStations } from '@evtivity/database';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

export async function configDriftDetectionHandler(log: Logger): Promise<void> {
  const { configTemplates, stationConfigurations } = await import('@evtivity/database');

  // Get all templates with variables
  const templates = await db.select().from(configTemplates);

  let driftCount = 0;

  for (const template of templates) {
    const variables = template.variables as Array<{
      component: string;
      variable: string;
      value: string;
    }>;
    if (variables.length === 0) continue;

    // Resolve target stations from filter
    const filter = template.targetFilter as Record<string, string> | null;
    const conditions = [eq(chargingStations.isOnline, true)];
    if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
    if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
    if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

    const targetStations = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(and(...conditions));

    for (const station of targetStations) {
      const actualVars = await db
        .select()
        .from(stationConfigurations)
        .where(eq(stationConfigurations.stationId, station.id));

      for (const expected of variables) {
        const actual = actualVars.find(
          (v) => v.component === expected.component && v.variable === expected.variable,
        );
        if (actual == null || actual.value !== expected.value) {
          driftCount++;
          try {
            const pubsub = getPubSub();
            await pubsub.publish(
              'csms_events',
              JSON.stringify({
                eventType: 'config.driftDetected',
                stationId: station.id,
                sessionId: null,
                siteId: null,
              }),
            );
          } catch {
            // Best-effort SSE notification
          }
          break; // One drift per station is enough to flag
        }
      }
    }
  }

  if (driftCount > 0) {
    log.info({ driftCount }, 'Configuration drift detected');
  }
}
