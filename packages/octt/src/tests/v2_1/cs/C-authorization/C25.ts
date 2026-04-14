// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_127_CS: Ad hoc payment via static or dynamic QR code - no URL parameters
 * Skipped: requires QR code display and WebPaymentsCtrlr that the CSS does not support.
 */
export const TC_C_127_CS: CsTestCase = {
  id: 'TC_C_127_CS',
  name: 'Ad hoc payment via static or dynamic QR code - no URL parameters',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Provide a static or dynamic QR code with a URL for ad hoc payment.',
  purpose:
    'To verify if the Charging Station supports ad hoc payments with a url without URL parameters.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_128_CS: Ad hoc payment via static or dynamic QR code - URL parameter maxTime
 * Skipped: requires QR code display and WebPaymentsCtrlr that the CSS does not support.
 */
export const TC_C_128_CS: CsTestCase = {
  id: 'TC_C_128_CS',
  name: 'Ad hoc payment via static or dynamic QR code - URL parameter maxTime',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Provide a static or dynamic QR code with a URL for ad hoc payment with maxTime parameter.',
  purpose:
    'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxTime.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_129_CS: Ad hoc payment via static or dynamic QR code - URL parameter maxCost
 * Skipped: requires QR code display and WebPaymentsCtrlr that the CSS does not support.
 */
export const TC_C_129_CS: CsTestCase = {
  id: 'TC_C_129_CS',
  name: 'Ad hoc payment via static or dynamic QR code - URL parameter maxCost',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Provide a static or dynamic QR code with a URL for ad hoc payment with maxCost parameter.',
  purpose:
    'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxCost.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_130_CS: Ad hoc payment via static or dynamic QR code - URL parameter maxEnergy
 * Skipped: requires QR code display and WebPaymentsCtrlr that the CSS does not support.
 */
export const TC_C_130_CS: CsTestCase = {
  id: 'TC_C_130_CS',
  name: 'Ad hoc payment via static or dynamic QR code - URL parameter maxEnergy',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Provide a static or dynamic QR code with a URL for ad hoc payment with maxEnergy parameter.',
  purpose:
    'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxEnergy.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
