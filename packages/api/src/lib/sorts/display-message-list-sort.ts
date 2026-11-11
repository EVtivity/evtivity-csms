// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { displayMessages } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/stations/:stationId/display-messages` (`api/routes.md`,
 * "List sorting"). Priority, format, state and status are enums: they sort in their
 * declared order, not alphabetically.
 */
export const displayMessageListSort = defineListSort(
  {
    messageId: displayMessages.ocppMessageId,
    priority: displayMessages.priority,
    content: displayMessages.content,
    format: displayMessages.format,
    state: displayMessages.state,
    status: displayMessages.status,
    createdAt: displayMessages.createdAt,
  },
  {
    tieBreaker: displayMessages.id,
    defaultOrder: [desc(displayMessages.createdAt), desc(displayMessages.id)],
  },
);
