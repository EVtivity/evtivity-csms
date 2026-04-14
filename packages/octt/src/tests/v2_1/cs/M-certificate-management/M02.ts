// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

const createSkippedPkiTest = (
  id: string,
  name: string,
  description: string,
  purpose: string,
): CsTestCase => ({
  id,
  name,
  module: 'M-certificate-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description,
  purpose,
  execute: async (_ctx) => ({ status: 'skipped' as const, durationMs: 0, steps: [] }),
});

export const TC_M_28_CS = createSkippedPkiTest(
  'TC_M_28_CS',
  'Certificate Update EV - Success',
  'The EV initiates updating the existing certificate. The Charging Station forwards the update request.',
  'To verify if the Charging Station is able to forward the request to the CSMS.',
);

export const TC_M_29_CS = createSkippedPkiTest(
  'TC_M_29_CS',
  'Certificate Update EV - Failed',
  'The EV initiates updating the existing certificate. The CSMS responds with Failed.',
  'To verify if the Charging Station is able to forward the request to the CSMS.',
);
