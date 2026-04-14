// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { chargingStations, evses, connectors } from '@evtivity/database';

export async function listStations() {
  return db.select().from(chargingStations).orderBy(desc(chargingStations.createdAt));
}

export async function getStation(id: string) {
  const [station] = await db.select().from(chargingStations).where(eq(chargingStations.id, id));
  return station ?? null;
}

export async function createStation(data: {
  stationId: string;
  model?: string;
  serialNumber?: string;
  vendorId?: string;
}) {
  const [station] = await db.insert(chargingStations).values(data).returning();
  return station;
}

export async function updateStation(
  id: string,
  data: {
    model?: string | undefined;
    serialNumber?: string | undefined;
    status?: 'available' | 'unavailable' | 'faulted' | 'removed' | undefined;
  },
) {
  const [station] = await db
    .update(chargingStations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(chargingStations.id, id))
    .returning();
  return station ?? null;
}

export async function removeStation(id: string) {
  const [station] = await db
    .update(chargingStations)
    .set({ onboardingStatus: 'blocked', updatedAt: new Date() })
    .where(eq(chargingStations.id, id))
    .returning();
  return station ?? null;
}

export async function getStationEvses(stationId: string) {
  return db.select().from(evses).where(eq(evses.stationId, stationId));
}

export async function getEvseConnectors(evseId: string) {
  return db.select().from(connectors).where(eq(connectors.evseId, evseId));
}
