// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';

/**
 * An in-memory stand-in for `../lib/site-access.js` in route unit tests, so a
 * site check does not read the mocked database. Use it as the mock factory:
 *
 *   vi.mock('../lib/site-access.js', async () =>
 *     (await import('./helpers/site-access-mock.js')).siteAccessMock(),
 *   );
 *
 * and set the caller's sites with `setMockUserSiteIds` (null: every site, the
 * default). A site-restricted user never sees an unsited row. Station checks
 * answer by the station's site in `setMockStationSites` (an unknown station is
 * allowed for an all-site user only).
 */
let userSiteIds: string[] | null = null;
let stationSites = new Map<string, string | null>();

export function setMockUserSiteIds(siteIds: string[] | null): void {
  userSiteIds = siteIds;
}

export function setMockStationSites(sites: Record<string, string | null>): void {
  stationSites = new Map(Object.entries(sites));
}

/** Resets the mock to an all-site user with no known stations. */
export function resetSiteAccessMock(): void {
  userSiteIds = null;
  stationSites = new Map();
}

function allowed(siteIds: string[] | null, siteId: string | null | undefined): boolean {
  if (siteIds == null) return true;
  return siteId != null && siteIds.includes(siteId);
}

interface MockReply {
  status: (code: number) => { send: (body: unknown) => unknown };
}

/**
 * Every helper reads the caller's sites through the mocked getUserSiteIds, so
 * a test can also restrict one request with
 * `vi.mocked(getUserSiteIds).mockResolvedValueOnce([...])`.
 */
export function siteAccessMock(): Record<string, unknown> {
  const getUserSiteIds = vi.fn((_userId: string) => Promise.resolve(userSiteIds));
  return {
    getUserSiteIds,
    isAllSiteUser: vi.fn(async (userId: string) => (await getUserSiteIds(userId)) == null),
    userCanAccessSite: vi.fn(async (userId: string, siteId: string | null | undefined) =>
      allowed(await getUserSiteIds(userId), siteId),
    ),
    checkStationSiteAccess: vi.fn(async (stationId: string, userId: string) => {
      const siteIds = await getUserSiteIds(userId);
      if (siteIds == null) return true;
      return stationSites.has(stationId) && allowed(siteIds, stationSites.get(stationId));
    }),
    requireAllSiteAccess: vi.fn(
      async (request: { user?: unknown }, reply: MockReply, notFound: unknown) => {
        const { userId } = (request.user ?? {}) as { userId: string };
        if ((await getUserSiteIds(userId)) == null) return true;
        await reply.status(404).send(notFound);
        return false;
      },
    ),
    assertSitesWithinScope: vi.fn(async (userId: string, siteIds: readonly string[]) => {
      const scope = await getUserSiteIds(userId);
      return siteIds.every((id) => allowed(scope, id));
    }),
    invalidateSiteAccessCache: vi.fn(),
    clearSiteAccessCacheLocal: vi.fn(),
  };
}
