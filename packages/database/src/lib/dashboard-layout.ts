// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of user_dashboard_layouts. The layout routes
// (`/v1/users/me/dashboard-layout`) validate and resolve a layout with
// `@evtivity/lib/dashboard-layout` and store it here; a stored layout is a
// full replace, and a delete returns the user to the default layout.

import { eq, inArray } from 'drizzle-orm';
import type { DashboardLayout } from '@evtivity/lib/dashboard-layout';
import { db } from '../config.js';
import { userDashboardLayouts } from '../schema/identity.js';
import { sites } from '../schema/assets.js';

/** The stored layout of the user (unresolved), or null when the user has none. */
export async function getUserDashboardLayout(userId: string): Promise<unknown> {
  const [row] = await db
    .select({ layout: userDashboardLayouts.layout })
    .from(userDashboardLayouts)
    .where(eq(userDashboardLayouts.userId, userId));
  return row?.layout ?? null;
}

/** Stores the layout of the user, replacing the one stored before. */
export async function saveUserDashboardLayout(
  userId: string,
  layout: DashboardLayout,
): Promise<void> {
  await db
    .insert(userDashboardLayouts)
    .values({ userId, layout })
    .onConflictDoUpdate({
      target: [userDashboardLayouts.userId],
      set: { layout, updatedAt: new Date() },
    });
}

/** Removes the stored layout of the user (idempotent). */
export async function deleteUserDashboardLayout(userId: string): Promise<void> {
  await db.delete(userDashboardLayouts).where(eq(userDashboardLayouts.userId, userId));
}

/**
 * The ids of the given sites that exist (a read for the layout routes, which
 * drop a widget site that was deleted).
 */
export async function existingDashboardSiteIds(siteIds: readonly string[]): Promise<Set<string>> {
  if (siteIds.length === 0) return new Set();
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(inArray(sites.id, [...siteIds]));
  return new Set(rows.map((r) => r.id));
}
