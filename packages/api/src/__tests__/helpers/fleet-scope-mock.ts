// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';
import type { UserAccess } from '../../lib/fleet-scope.js';

/**
 * An in-memory stand-in for `../lib/fleet-scope.js` in unit tests whose
 * database mock cannot answer the access scope read. Use it as the mock factory:
 *
 *   vi.mock('../lib/fleet-scope.js', async () =>
 *     (await import('./helpers/fleet-scope-mock.js')).fleetScopeMock(),
 *   );
 *
 * Every user has the sites scope unless `setMockUserAccess` names it a fleet user.
 */
let accessByUser = new Map<string, UserAccess>();

export function setMockUserAccess(userId: string, access: UserAccess): void {
  accessByUser.set(userId, access);
}

/** Resets the mock: every user has the sites scope. */
export function resetFleetScopeMock(): void {
  accessByUser = new Map();
}

function accessOf(userId: string): UserAccess {
  return accessByUser.get(userId) ?? { kind: 'sites' };
}

export async function fleetScopeMock(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import('../../lib/fleet-scope.js')>(
    '../../lib/fleet-scope.js',
  );
  return {
    ...actual,
    getUserAccessScope: vi.fn((userId: string) => Promise.resolve(accessOf(userId))),
    isFleetUser: vi.fn((userId: string) => Promise.resolve(accessOf(userId).kind === 'fleets')),
    userAccessFields: vi.fn((userId: string) => {
      const access = accessOf(userId);
      return Promise.resolve(
        access.kind === 'fleets'
          ? { accessScope: 'fleets', fleetIds: access.fleetIds }
          : { accessScope: 'sites', fleetIds: [] },
      );
    }),
    clearFleetScopeCacheLocal: vi.fn(),
    requireFleetAccess: vi.fn(
      async (
        request: { user: { userId: string } },
        reply: { status: (n: number) => { send: (b: unknown) => Promise<unknown> } },
        fleetId: string,
      ) => {
        if (actual.fleetInScope(accessOf(request.user.userId), fleetId)) return true;
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return false;
      },
    ),
  };
}
