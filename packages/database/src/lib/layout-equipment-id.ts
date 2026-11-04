// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';

/**
 * The table id of a transformer (`tfm`) or energy asset (`ena`) that a site
 * layout named `layoutId` before the equipment moved into the load
 * management tables: the prefix and the first 12 hex digits of
 * md5(`<siteId>:<layoutId>`), the id the v0.1.50 migration gives the row it
 * moves out of `sites.layout_settings`. The demo seeds name their equipment
 * the same way, so a seed rerun over a migrated database finds the moved rows.
 */
export function layoutEquipmentRowId(
  prefix: 'tfm' | 'ena',
  siteId: string,
  layoutId: string,
): string {
  const hash = createHash('md5').update(`${siteId}:${layoutId}`).digest('hex');
  return `${prefix}_${hash.slice(0, 12)}`;
}
