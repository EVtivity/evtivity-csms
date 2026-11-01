// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Generated avatars for the demo drivers, so the site layout shows a face over
// a charging car and the driver lists look lived in. Demo data only: the demo
// drivers are the ones the demo seeds create on the reserved example domains
// (`driverN@example.com`, `*@*.example`) and the seeded `@evtivity.local`
// driver accounts (`DEMO_DRIVER_EMAIL_SQL`). Each avatar is ordinary and fixed per
// driver (a hash of the driver id picks the hair, skin, clothes and colors from
// a calm subset of the allow-list, no odd accessories), and every one passes
// `generatedAvatarProblem`.
//
// The avatar writer is `driver-avatar.service.ts` in the API, which the
// database package cannot import; this seed is the one other writer the
// avatar writer guard allows, and it writes a driver only while the driver has
// no avatar (`avatar_kind IS NULL`) and is not erased, so a rerun, a driver's
// own avatar and an operator's change stay. Each write is audited like the
// service's (`driver.updated`, kinds only).

import type postgres from 'postgres';
import { generatedAvatarProblem } from '@evtivity/lib/account-avatar';
import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import { writeAudit } from './lib/audit.js';
import { driverAuditLog } from './schema/audit.js';
import { demoDriverAvatar } from './seed-demo-avatar-options.js';

export { demoDriverAvatar };

/**
 * The demo driver emails: the reserved example domains the demo seeds use, and
 * the seeded `@evtivity.local` accounts (the portal test driver
 * `driver@evtivity.local`, the fleet account driver). The simulator charges
 * with every active driver token, so these drivers show over the cars of the
 * demo sites too. The OCTT conformance driver belongs to its runs and stays
 * without one.
 */
export const DEMO_DRIVER_EMAIL_SQL = `((lower(email) LIKE '%@example.com' OR lower(email) LIKE '%.example' OR lower(email) LIKE '%@evtivity.local') AND lower(email) <> '${OCTT_TEST_DRIVER_EMAIL}')`;

/**
 * Gives every demo driver without an avatar its generated one, or only the
 * demo drivers in `driverIds` (the docs screenshot tooling passes the drivers
 * it creates). A driver outside the demo domains is never written. Returns the
 * drivers written.
 */
export async function seedDemoDriverAvatars(
  sql: postgres.Sql,
  actorUserId: string | null,
  driverIds?: readonly string[],
): Promise<number> {
  if (driverIds != null && driverIds.length === 0) return 0;
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM drivers
    WHERE avatar_kind IS NULL AND erased_at IS NULL AND email IS NOT NULL
      AND ${sql.unsafe(DEMO_DRIVER_EMAIL_SQL)}
      ${driverIds != null ? sql`AND id IN ${sql(driverIds)}` : sql``}
    ORDER BY id
  `;
  let written = 0;
  for (const row of rows) {
    const avatar = demoDriverAvatar(row.id);
    const problem = generatedAvatarProblem(avatar);
    if (problem != null) throw new Error(`Demo avatar of ${row.id} refused: ${problem}`);
    const updated = await sql`
      UPDATE drivers SET avatar_kind = 'generated', avatar_options = ${sql.json(avatar as unknown as postgres.JSONValue)},
        avatar_updated_at = now(), updated_at = now()
      WHERE id = ${row.id} AND avatar_kind IS NULL AND erased_at IS NULL
      RETURNING id
    `;
    if (updated.length === 0) continue;
    written++;
    await writeAudit(
      { table: driverAuditLog, idColumn: 'driver_id' },
      {
        entityId: row.id,
        entityIdSnapshot: row.id,
        action: 'updated',
        actor: actorUserId != null ? 'operator' : 'system',
        actorUserId,
        before: { avatar: null },
        after: { avatar: 'generated' },
        notes: 'Demo data: generated avatar',
      },
    );
  }
  return written;
}
