// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

type RegistrationPolicy = 'open' | 'approval-required';

let cachedPolicy: RegistrationPolicy | undefined;
let cachedPolicyAt = 0;

const TTL_MS = 60_000;

export async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
  const now = Date.now();
  if (cachedPolicy !== undefined && now - cachedPolicyAt < TTL_MS) {
    return cachedPolicy;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'ocpp.registrationPolicy'));

    cachedPolicy = row != null && row.value === 'open' ? 'open' : 'approval-required';
    cachedPolicyAt = now;
    return cachedPolicy;
  } catch {
    return cachedPolicy ?? 'approval-required';
  }
}

export function clearRegistrationPolicyCache(): void {
  cachedPolicy = undefined;
  cachedPolicyAt = 0;
}
