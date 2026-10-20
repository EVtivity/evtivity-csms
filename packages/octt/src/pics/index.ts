// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppVersion, SutType } from '../types.js';
import type { NotApplicable, Pics, PicsCondition, PicsItem, TestProfile } from './types.js';
import { PICS_CSMS_V1_6 } from './csms-v1_6.js';
import { PICS_CSMS_V2_0_1 } from './csms-v2_0_1.js';
import { PICS_CSMS_V2_1 } from './csms-v2_1.js';
import { PICS_V1_6 } from './v1_6.js';
import { PICS_V2_0_1 } from './v2_0_1.js';
import { PICS_V2_1 } from './v2_1.js';

export type {
  NotApplicable,
  Pics,
  PicsCondition,
  PicsItem,
  PicsPrerequisite,
  ProfileRequirement,
  TestProfile,
} from './types.js';
export { PICS_CSMS_V1_6 } from './csms-v1_6.js';
export { PICS_CSMS_V2_0_1 } from './csms-v2_0_1.js';
export { PICS_CSMS_V2_1 } from './csms-v2_1.js';
export { PICS_V1_6 } from './v1_6.js';
export { PICS_V2_0_1 } from './v2_0_1.js';
export { PICS_V2_1 } from './v2_1.js';

/** PICS of the Device Under Test: the CSMS (`csms`) or the charging station simulator (`cs`). */
export function getPics(version: OcppVersion, sut: SutType): Pics {
  if (sut === 'csms') {
    if (version === 'ocpp1.6') return PICS_CSMS_V1_6;
    return version === 'ocpp2.0.1' ? PICS_CSMS_V2_0_1 : PICS_CSMS_V2_1;
  }
  if (version === 'ocpp1.6') return PICS_V1_6;
  return version === 'ocpp2.0.1' ? PICS_V2_0_1 : PICS_V2_1;
}

/**
 * The certification profiles that list a test for the Device Under Test, an
 * empty list for an informative test, or null when the PICS maps no profiles.
 */
export function getTestProfiles(
  testId: string,
  version: OcppVersion,
  sut: SutType,
  pics: Pics = getPics(version, sut),
): TestProfile[] | null {
  if (pics.profiles == null) return null;
  const profiles = pics.profiles[testId];
  if (profiles == null) {
    throw new Error(
      `PICS ${pics.sut} ${pics.version}: no certification profile entry for ${testId}`,
    );
  }
  return profiles;
}

function lookup(pics: Pics, testId: string, id: string): PicsItem {
  const item = pics.items[id];
  if (item == null) {
    throw new Error(`PICS ${pics.sut} ${pics.version}: ${testId} references unknown item ${id}`);
  }
  return item;
}

const why = (item: PicsItem): string => item.reason ?? item.description;

/**
 * Returns why a test case does not apply to the Device Under Test per its
 * PICS, or null when it applies. A condition that names an item missing from
 * the PICS throws: that is a PICS authoring error, not a property of the
 * product.
 */
export function getNotApplicable(
  testId: string,
  version: OcppVersion,
  sut: SutType,
  pics: Pics = getPics(version, sut),
): NotApplicable | null {
  const prerequisites = pics.testPrerequisites[testId];
  if (prerequisites == null) return null;
  for (const prerequisite of prerequisites) {
    if ('anyOf' in prerequisite) {
      const options: PicsCondition[] = prerequisite.anyOf.map((option) =>
        typeof option === 'string' ? { item: option, requires: true } : option,
      );
      const items = options.map((o) => lookup(pics, testId, o.item));
      if (options.some((o, i) => items[i]?.supported === o.requires)) continue;
      const names = options.map((o) => (o.requires ? o.item : `NOT ${o.item}`));
      const holds = options.every((o) => o.requires) ? 'supported' : 'holds';
      return {
        item: names.join(' | '),
        reason: `PICS none of ${names.join(', ')} ${holds}: ${items.map(why).join('; ')}`,
      };
    }
    const item = lookup(pics, testId, prerequisite.item);
    if (item.supported === prerequisite.requires) continue;
    const reason = prerequisite.requires
      ? `PICS ${item.id} not supported: ${why(item)}`
      : `PICS ${item.id} supported: test requires a ${sut === 'cs' ? 'station' : 'CSMS'} without it (${item.description})`;
    return { item: item.id, reason };
  }
  return null;
}
