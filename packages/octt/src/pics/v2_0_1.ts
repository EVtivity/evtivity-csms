// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Pics, PicsItem, PicsPrerequisite } from './types.js';
import { PICS_V2_1 } from './v2_1.js';
import { OCPP201_CS_TEST_IDS } from '../ocpp201-cs-cases.js';

const OCPP201_IDS = new Set(OCPP201_CS_TEST_IDS);

/**
 * PICS of the EVtivity charging station simulator (CSS) for OCPP 2.0.1.
 *
 * A 2.0.1 simulator station runs the 2.1 code paths behind its 2.0.1 edge
 * (`packages/css/src/lib/ocpp201.ts`), so it supports the same features: the
 * items are the 2.1 ones. OCPP 2.0.1 Edition 4 Part 5 chapter 4 gives the
 * 2.0.1 cases the same charging station conditions as 2.1 Part 5, except that
 * 2.0.1 drops `NOT HFS-13` (battery swapping, unsupported, so it holds in both),
 * and lists the ISO 15118 cases as mandatory within the ISO 15118 support
 * profile, which the simulator does not have. TC_C_100 and TC_C_127 (not in
 * 2.0.1 Part 5) and TC_N_34 keep their Part 6 prerequisite, as in 2.1. So the
 * conditions are the 2.1 ones of the 2.0.1 ids.
 *
 * Two items differ. QR code payment (P-2.4) is a 2.1 feature, though 2.0.1
 * Part 6 lists TC_C_127. And the 2.1 simulator leaves the 2.1 message states Suspended
 * and Discharging out of DisplayMessageCtrlr.SupportedStates, but supports
 * every 2.0.1 state, so TC_O_18 (NotSupportedState) has no state to send.
 */
const items: Record<string, PicsItem> = {
  ...PICS_V2_1.items,
  // 2.0.1 Part 6 ed4 lists TC_C_127 (C25), but its messages exist in 2.1 only.
  'P-2.4': {
    id: 'P-2.4',
    description: 'QR code payment (C25, WebPaymentsCtrlr)',
    supported: false,
    reason:
      'OCPP 2.0.1 has no QR code payment: SetDefaultTariff, NotifyWebPaymentStarted and the WebPaymentsCtrlr component are OCPP 2.1 only',
  },
  UnsupportedDisplayMessageState: {
    id: 'UnsupportedDisplayMessageState',
    description:
      'The Charging Station does not support all message states of the OCPP version (TC_O_18_CS prerequisite)',
    supported: false,
    reason:
      'The simulator supports every OCPP 2.0.1 MessageStateEnumType value (Charging, Faulted, Idle, Unavailable)',
  },
};

const testPrerequisites: Record<string, PicsPrerequisite[]> = Object.fromEntries(
  Object.entries(PICS_V2_1.testPrerequisites).filter(([id]) => OCPP201_IDS.has(id)),
);

export const PICS_V2_0_1: Pics = {
  sut: 'cs',
  version: 'ocpp2.0.1',
  items,
  testPrerequisites,
};
