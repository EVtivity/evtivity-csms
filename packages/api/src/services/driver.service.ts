// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { drivers, driverTokens } from '@evtivity/database';
import * as tokenService from './token.service.js';

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

// Both functions delegate to tokenService so audit + driver notification +
// reactive local-auth invalidation always fire, matching every other token
// mutation path. The system actor is used here because callers (legacy seed,
// test fixtures) don't carry a user/driver context. Real interactive flows
// should call tokenService directly with the right actor.
export async function createDriverToken(
  driverId: string,
  data: { idToken: string; tokenType: string },
) {
  return tokenService.createToken(
    { driverId, idToken: data.idToken, tokenType: data.tokenType },
    { type: 'system' },
  );
}

export async function deactivateDriverToken(tokenId: string) {
  return tokenService.updateToken(
    tokenId,
    { isActive: false, revokedReason: 'Deactivated via driver service' },
    { type: 'system' },
  );
}
