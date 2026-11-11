// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { notifications } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/notifications` (`api/routes.md`, "List sorting"). The
 * timestamp sorts as the log tabs show it: the send time, else the creation time.
 */
export const notificationListSort = defineListSort(
  {
    timestamp: sql`coalesce(${notifications.sentAt}, ${notifications.createdAt})`,
    recipient: notifications.recipient,
    subject: notifications.subject,
    eventType: notifications.eventType,
    status: notifications.status,
  },
  {
    tieBreaker: notifications.id,
    defaultOrder: [desc(notifications.createdAt), desc(notifications.id)],
  },
);
