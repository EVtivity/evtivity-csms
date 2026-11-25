// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';

/**
 * The fence of the site lock a load management cycle runs under: the
 * `site_load_management.cycle_fence` value its holder took, and the signal the
 * lock aborts when its lease was lost. A claim or a send of an older holder
 * finds a newer fence and does nothing.
 */
export interface LoadManagementFence {
  siteId: string;
  fence: number;
  signal?: AbortSignal;
}

const fenceStorage = new AsyncLocalStorage<LoadManagementFence>();

/**
 * Raises the site's fence for a new lock holder and returns it. Null when the
 * site has no load management row (nothing to fence).
 */
export async function takeLoadManagementFence(
  sql: postgres.Sql,
  siteId: string,
): Promise<number | null> {
  const rows = await sql<{ fence: string | number }[]>`
    UPDATE site_load_management
    SET cycle_fence = cycle_fence + 1
    WHERE site_id = ${siteId}
    RETURNING cycle_fence AS fence
  `;
  const value = rows[0]?.fence;
  return value == null ? null : Number(value);
}

/** Runs `fn` with `fence` as the fence of its site's claims and sends. */
export function runWithLoadManagementFence<T>(
  fence: LoadManagementFence,
  fn: () => Promise<T>,
): Promise<T> {
  return fenceStorage.run(fence, fn);
}

/** The fence the running cycle holds for `siteId`, if it runs under one. */
export function currentLoadManagementFence(siteId: string): LoadManagementFence | undefined {
  const fence = fenceStorage.getStore();
  return fence?.siteId === siteId ? fence : undefined;
}

/**
 * Whether the running cycle may still write and send for `siteId`: true
 * outside a fenced cycle (the API GET, tests), false once its lock lease was
 * lost or a newer holder raised the fence.
 */
export async function loadManagementFenceHolds(
  sql: postgres.Sql,
  siteId: string,
): Promise<boolean> {
  const fence = currentLoadManagementFence(siteId);
  if (fence == null) return true;
  if (fence.signal?.aborted === true) return false;
  const rows = await sql<{ fence: string | number }[]>`
    SELECT cycle_fence AS fence FROM site_load_management WHERE site_id = ${siteId}
  `;
  const stored = rows[0]?.fence;
  return stored != null && Number(stored) === fence.fence;
}
