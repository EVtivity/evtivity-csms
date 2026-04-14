// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { drivers, driverTokens } from '@evtivity/database';

export async function listDrivers() {
  return db.select().from(drivers).orderBy(desc(drivers.createdAt));
}

export async function getDriver(id: string) {
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, id));
  return driver ?? null;
}

export async function createDriver(data: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}) {
  const [driver] = await db.insert(drivers).values(data).returning();
  return driver;
}

export async function updateDriver(
  id: string,
  data: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    isActive?: boolean;
  },
) {
  const [driver] = await db
    .update(drivers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(drivers.id, id))
    .returning();
  return driver ?? null;
}

export async function getDriverTokens(driverId: string) {
  return db.select().from(driverTokens).where(eq(driverTokens.driverId, driverId));
}

export async function createDriverToken(
  driverId: string,
  data: { idToken: string; tokenType: string },
) {
  const [token] = await db
    .insert(driverTokens)
    .values({ driverId, ...data })
    .returning();
  return token;
}

export async function deactivateDriverToken(tokenId: string) {
  const [token] = await db
    .update(driverTokens)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(driverTokens.id, tokenId))
    .returning();
  return token ?? null;
}
