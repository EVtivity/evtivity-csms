// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The fixed generated avatar of a demo driver (no database import), so the demo
// avatar seed and the site layout render harness give a driver the same face.

import { createHash } from 'node:crypto';
import { AVATAR_STYLE } from '@evtivity/lib/account-avatar';
import type { GeneratedAvatar } from '@evtivity/lib/account-avatar';

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
