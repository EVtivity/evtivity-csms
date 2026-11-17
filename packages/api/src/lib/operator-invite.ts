// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, client, fleets, userFleetAssignments } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';
import type { UserAccessScope } from '@evtivity/lib/user-access-scope';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, TEMPLATES_DIR];

export interface OperatorInviteUser {
  id: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string;
  accessScope: UserAccessScope;
}

/** The names of the fleets a fleet user manages, by name. */
async function fleetNamesOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: fleets.name })
    .from(userFleetAssignments)
    .innerJoin(fleets, eq(fleets.id, userFleetAssignments.fleetId))
    .where(eq(userFleetAssignments.userId, userId));
  return rows.map((row) => row.name).sort((a, b) => a.localeCompare(b));
}

/**
 * The invitation with the password setup link: `operator.FleetManagerInvite`
 * for a fleet user (what it can do with its fleets), else `operator.UserCreated`. Returns the event sent; dispatch is
 * not awaited (fail-open, the account already exists).
 */
export async function sendOperatorInvite(
  user: OperatorInviteUser,
  setPasswordUrl: string,
): Promise<'operator.FleetManagerInvite' | 'operator.UserCreated'> {
  const recipient = {
    email: user.email,
    phone: user.phone ?? undefined,
    userId: user.id,
    language: user.language,
  };
  const base = {
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    email: user.email,
    setPasswordUrl,
  };
  if (user.accessScope === 'fleets') {
    const names = await fleetNamesOf(user.id);
    void dispatchSystemNotification(
      client,
      'operator.FleetManagerInvite',
      recipient,
      {
        ...base,
        fleetNames: names.join(', '),
        fleetCount: names.length,
      },
      ALL_TEMPLATES_DIRS,
    );
    return 'operator.FleetManagerInvite';
  }
  void dispatchSystemNotification(
    client,
    'operator.UserCreated',
    recipient,
    base,
    ALL_TEMPLATES_DIRS,
  );
  return 'operator.UserCreated';
}
