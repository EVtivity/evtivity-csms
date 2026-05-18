// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Post-migrate hook: ensures every user with the 'admin' role has every
// permission in ADMIN_DEFAULT_PERMISSIONS. Wired into `npm run db:migrate`
// (packages/database/package.json) after drizzle-kit migrate + the
// verify-migrations script. ON CONFLICT DO NOTHING -- never revokes.
//
// Why this exists: adding a new permission to packages/lib/src/permissions.ts
// previously required the developer to remember a separate backfill migration.
// When that step was skipped, existing admins silently lacked the permission
// and every UI surface gated by it returned 403 until a manual SQL backfill.
// This script makes the contract automatic for admin users: any permission
// newly added to ADMIN_DEFAULT_PERMISSIONS propagates to every existing admin
// on the next `db:migrate`. Non-admin roles still need explicit backfill
// migrations because their default set is a curated subset, not "all".

import postgres from 'postgres';
import { ADMIN_DEFAULT_PERMISSIONS } from '@evtivity/lib';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity';

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  const admins = await sql<{ id: string }[]>`
    SELECT u.id FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'admin'
  `;

  if (admins.length === 0) {
    console.log('sync-admin-permissions: no admin users found, nothing to do');
    process.exit(0);
  }

  const rows: Array<{ user_id: string; permission: string }> = [];
  for (const admin of admins) {
    for (const permission of ADMIN_DEFAULT_PERMISSIONS) {
      rows.push({ user_id: admin.id, permission });
    }
  }

  const result = await sql`
    INSERT INTO user_permissions ${sql(rows, 'user_id', 'permission')}
    ON CONFLICT DO NOTHING
  `;
  console.log(
    `sync-admin-permissions: ${String(admins.length)} admin(s), ${String(ADMIN_DEFAULT_PERMISSIONS.length)} perms each, ${String(result.count)} new row(s) inserted`,
  );
} finally {
  await sql.end();
}
