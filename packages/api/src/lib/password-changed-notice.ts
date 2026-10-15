// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, client, users } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';

const currentDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, TEMPLATES_DIR];

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

async function notifyPasswordChanged(userId: string): Promise<void> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      phone: users.phone,
      firstName: users.firstName,
      lastName: users.lastName,
      language: users.language,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (user == null) return;
  await dispatchSystemNotification(
    client,
    'operator.PasswordChanged',
    {
      email: user.email,
      phone: user.phone ?? undefined,
      userId: user.id,
      language: user.language,
    },
    { firstName: user.firstName ?? '', lastName: user.lastName ?? '', email: user.email },
    ALL_TEMPLATES_DIRS,
  );
}

/**
 * Tells the operator that the account password changed
 * (`operator.PasswordChanged`, email and SMS), whoever changed it: the user,
 * a reset link, or an admin. Not awaited; a failure is logged at warn
 * (fail-open, the password already changed).
 */
export function sendPasswordChangedNotice(userId: string, log: Logger): void {
  void notifyPasswordChanged(userId).catch((err: unknown) => {
    log.warn({ err, userId }, 'Password changed notice failed');
  });
}
