// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { chargingSessions } from '@evtivity/database';

export async function listSessions(limit: number = 100) {
  return db.select().from(chargingSessions).orderBy(desc(chargingSessions.createdAt)).limit(limit);
}

export async function getSession(id: string) {
  const [session] = await db.select().from(chargingSessions).where(eq(chargingSessions.id, id));
  return session ?? null;
}
