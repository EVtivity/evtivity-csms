// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Generated avatars for the demo drivers, so the site layout shows a face over
// a charging car and the driver lists look lived in. Demo data only: the demo
// drivers are the ones the demo seeds create on the reserved example domains
// (`driverN@example.com`, `*@*.example`). Each avatar is ordinary and fixed per
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

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { AVATAR_STYLE, generatedAvatarProblem } from '@evtivity/lib/account-avatar';
import type { GeneratedAvatar } from '@evtivity/lib/account-avatar';
import { writeAudit } from './lib/audit.js';
import { driverAuditLog } from './schema/audit.js';

const HAIR = [
  'bob',
  'bun',
  'curly',
  'curvy',
  'bigHair',
  'dreads01',
  'frizzle',
  'fro',
  'longButNotTooLong',
  'miaWallace',
  'shaggy',
  'shavedSides',
  'shortCurly',
  'shortFlat',
  'shortRound',
  'shortWaved',
  'sides',
  'straight01',
  'straight02',
  'straightAndStrand',
  'theCaesar',
  'theCaesarAndSidePart',
] as const;
const SKIN = ['614335', 'd08b5b', 'ae5d29', 'edb98a', 'ffdbb4'] as const;
const HAIR_COLOR = ['a55728', '2c1b18', 'b58143', 'd6b370', '724133', '4a312c', 'e8e1e1'] as const;
const CLOTHES = [
  'blazerAndShirt',
  'blazerAndSweater',
  'collarAndSweater',
  'hoodie',
  'shirtCrewNeck',
  'shirtScoopNeck',
  'shirtVNeck',
] as const;
const CLOTHES_COLOR = [
  '262e33',
  '65c9ff',
  '5199e4',
  '25557c',
  'e6e6e6',
  '929598',
  '3c4f5c',
  'b1e2ff',
  'ffffff',
] as const;
const EYEBROWS = ['default', 'defaultNatural', 'flatNatural', 'raisedExcitedNatural'] as const;
const EYES = ['default', 'happy', 'squint'] as const;
const MOUTH = ['default', 'smile', 'twinkle', 'serious'] as const;
const GLASSES = ['prescription01', 'prescription02', 'round'] as const;
const BEARD = ['beardLight', 'beardMedium'] as const;
const BACKGROUND = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'e5e7eb'] as const;

/** The demo driver emails: the reserved example domains the demo seeds use. */
export const DEMO_DRIVER_EMAIL_SQL = `(lower(email) LIKE '%@example.com' OR lower(email) LIKE '%.example')`;

/**
 * The fixed avatar of a demo driver: the same driver id always gives the same
 * avatar. One driver in five wears glasses, one in four a light or medium beard.
 */
export function demoDriverAvatar(driverId: string): GeneratedAvatar {
  const bytes = createHash('sha256').update(driverId).digest();
  let cursor = 0;
  const next = (): number => bytes[cursor++ % bytes.length] ?? 0;
  const pick = <T>(values: readonly T[]): T => values[next() % values.length] as T;
  const hairColor = pick(HAIR_COLOR);
  const options: Record<string, string | number> = {
    topVariant: pick(HAIR),
    topProbability: 100,
    hairColor,
    skinColor: pick(SKIN),
    eyebrowsVariant: pick(EYEBROWS),
    eyesVariant: pick(EYES),
    mouthVariant: pick(MOUTH),
    clothesVariant: pick(CLOTHES),
    clothesColor: pick(CLOTHES_COLOR),
    accessoriesVariant: pick(GLASSES),
    accessoriesColor: '262e33',
    accessoriesProbability: next() % 5 === 0 ? 100 : 0,
    facialHairVariant: pick(BEARD),
    facialHairColor: hairColor,
    facialHairProbability: next() % 4 === 0 ? 100 : 0,
    hatColor: '262e33',
    backgroundColor: pick(BACKGROUND),
    flip: 'none',
  };
  const seed = `demo-${driverId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return { style: AVATAR_STYLE, seed, options };
}

/** Gives every demo driver without an avatar its generated one. Returns the drivers written. */
export async function seedDemoDriverAvatars(
  sql: postgres.Sql,
  actorUserId: string | null,
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM drivers
    WHERE avatar_kind IS NULL AND erased_at IS NULL AND email IS NOT NULL
      AND ${sql.unsafe(DEMO_DRIVER_EMAIL_SQL)}
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
