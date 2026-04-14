// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { pricingGroups, tariffs } from '@evtivity/database';

export async function listPricingGroups() {
  return db.select().from(pricingGroups).orderBy(desc(pricingGroups.createdAt));
}

export async function createPricingGroup(data: {
  name: string;
  description?: string;
  isDefault?: boolean;
}) {
  const [group] = await db.insert(pricingGroups).values(data).returning();
  return group;
}

export async function getGroupTariffs(groupId: string) {
  return db.select().from(tariffs).where(eq(tariffs.pricingGroupId, groupId));
}

export async function createTariff(
  groupId: string,
  data: {
    name: string;
    currency?: string;
    pricePerKwh?: string;
    pricePerMinute?: string;
    pricePerSession?: string;
  },
) {
  const [tariff] = await db
    .insert(tariffs)
    .values({ pricingGroupId: groupId, ...data })
    .returning();
  return tariff;
}
