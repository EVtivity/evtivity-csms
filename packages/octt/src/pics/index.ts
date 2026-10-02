// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppVersion, SutType } from '../types.js';
import type { NotApplicable, Pics, PicsItem } from './types.js';
import { PICS_CSMS_V1_6 } from './csms-v1_6.js';
import { PICS_CSMS_V2_1 } from './csms-v2_1.js';
import { PICS_V1_6 } from './v1_6.js';
import { PICS_V2_1 } from './v2_1.js';

export type { NotApplicable, Pics, PicsItem, PicsPrerequisite } from './types.js';
export { PICS_CSMS_V1_6 } from './csms-v1_6.js';
export { PICS_CSMS_V2_1 } from './csms-v2_1.js';
export { PICS_V1_6 } from './v1_6.js';
export { PICS_V2_1 } from './v2_1.js';

/** PICS of the Device Under Test: the CSMS (`csms`) or the charging station simulator (`cs`). */
export function getPics(version: OcppVersion, sut: SutType): Pics {
  if (sut === 'csms') return version === 'ocpp1.6' ? PICS_CSMS_V1_6 : PICS_CSMS_V2_1;
  return version === 'ocpp1.6' ? PICS_V1_6 : PICS_V2_1;
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
      const items = prerequisite.anyOf.map((id) => lookup(pics, testId, id));
      if (items.some((i) => i.supported)) continue;
      return {
        item: items.map((i) => i.id).join(' | '),
        reason: `PICS none of ${items.map((i) => i.id).join(', ')} supported: ${items.map(why).join('; ')}`,
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
