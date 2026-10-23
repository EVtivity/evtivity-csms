// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { hasPermission } from '@evtivity/lib';

/**
 * An in-memory stand-in for `../middleware/rbac.js` in route unit tests that
 * check which permissions a route needs. `authorize(...)` and
 * `requestHasPermission` answer with the same rules as the real middleware
 * (every listed permission must hold, write implies read) against the set
 * given to `setMockPermissions`, so no database is read:
 *
 *   vi.mock('../middleware/rbac.js', async () =>
 *     (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
 *   );
 *
 * A request without a valid JWT answers 401, one without a permission 403
 * `INSUFFICIENT_PERMISSIONS`, as `authorize()` does.
 */
let granted: string[] = [];

export function setMockPermissions(permissions: string[]): void {
  granted = [...permissions];
}

interface MockRequest {
  jwtVerify: () => Promise<void>;
}

interface MockReply {
  sent: boolean;
  status: (code: number) => { send: (body: unknown) => Promise<unknown> };
}

export function rbacPermissionMock(): Record<string, unknown> {
  return {
    authorize:
      (...required: string[]) =>
      async (request: MockRequest, reply: MockReply): Promise<void> => {
        try {
          await request.jwtVerify();
        } catch {
          await reply.status(401).send({ error: 'Unauthorized' });
          return;
        }
        for (const permission of required) {
          if (!hasPermission(granted, permission)) {
            await reply
              .status(403)
              .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
            return;
          }
        }
      },
    selfService:
      () =>
      async (request: MockRequest, reply: MockReply): Promise<void> => {
        try {
          await request.jwtVerify();
        } catch {
          await reply.status(401).send({ error: 'Unauthorized' });
        }
      },
    requestHasPermission: (_request: unknown, permission: string) =>
      Promise.resolve(hasPermission(granted, permission)),
    getEffectivePermissions: () => Promise.resolve([...granted]),
    invalidatePermissionCache: () => undefined,
    clearPermissionCacheLocal: () => undefined,
    getUserPermissions: () => Promise.resolve([...granted]),
  };
}
