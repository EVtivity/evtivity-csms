// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { createLogger } from '@evtivity/lib';

const logger = createLogger('portal-registration-setting');

let cachedValue: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

/**
 * Whether the portal driver self-registration endpoint
 * (`POST /v1/portal/auth/register`) should accept new sign-ups. Closed /
 * admin-provisioned deployments flip this off so the route returns 403
 * PORTAL_REGISTRATION_DISABLED. Default true when the setting row is missing
 * so existing installs that predate the toggle keep working unchanged.
 */
export async function isPortalRegistrationEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) {
    return cachedValue;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'portal.registrationEnabled'));

    cachedValue = row == null || row.value === true;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: 'portal.registrationEnabled' },
      'isPortalRegistrationEnabled failed, using the cached value or default',
    );
    return cachedValue ?? true;
  }
}
