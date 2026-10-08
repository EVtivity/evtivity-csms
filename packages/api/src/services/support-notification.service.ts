// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, client, users, roles, isSupportEnabled } from '@evtivity/database';
import { createLogger, dispatchSystemNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';

const logger = createLogger('support-notification');

async function resolveOperatorRecipient(
  assignedTo: string | null,
): Promise<{ userId: string; email: string; phone: string | null; language: string } | null> {
  if (assignedTo != null) {
    const [user] = await db
      .select({ id: users.id, email: users.email, phone: users.phone, language: users.language })
      .from(users)
      .where(eq(users.id, assignedTo));
    return user != null
      ? { userId: user.id, email: user.email, phone: user.phone, language: user.language }
      : null;
  }

  // Fall back to first admin user
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'admin'));
  if (adminRole == null) return null;

  const [adminUser] = await db
    .select({ id: users.id, email: users.email, phone: users.phone, language: users.language })
    .from(users)
    .where(eq(users.roleId, adminRole.id));

  return adminUser != null
    ? {
        userId: adminUser.id,
        email: adminUser.email,
        phone: adminUser.phone,
        language: adminUser.language,
      }
    : null;
}

export async function dispatchOperatorNotification(
  type: 'new_case' | 'driver_reply',
  caseId: string,
  caseNumber: string,
  subject: string,
  assignedTo: string | null,
): Promise<void> {
  try {
    const enabled = await isSupportEnabled();
    if (!enabled) return;

    const recipient = await resolveOperatorRecipient(assignedTo);
    if (recipient == null) return;

    const eventType =
      type === 'new_case' ? 'supportCase.NewCaseFromDriver' : 'supportCase.DriverReply';

    await dispatchSystemNotification(
      client,
      eventType,
      {
        email: recipient.email,
        phone: recipient.phone ?? undefined,
        userId: recipient.userId,
        language: recipient.language,
      },
      {
        caseId,
        caseNumber,
        subject,
        type,
      },
      ALL_TEMPLATES_DIRS,
    );
  } catch (err) {
    logger.warn(
      { err, caseId, type },
      'Support case operator notification failed, the request continues',
    );
  }
}
