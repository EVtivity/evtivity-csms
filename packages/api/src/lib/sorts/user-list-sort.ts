// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { users } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/users` (`api/routes.md`, "List sorting"). The role sorts
 * by the role name the list shows; the select is single-table, so the subquery names
 * "users" itself.
 */
export const userListSort = defineListSort(
  {
    name: sortablePersonName(users.firstName, users.lastName),
    email: users.email,
    role: sql`(select r.name from roles r where r.id = "users"."role_id")`,
    status: users.isActive,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
  },
  {
    tieBreaker: users.id,
    defaultOrder: [desc(users.createdAt), desc(users.id)],
  },
);
