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

export const TC_M_26_CS = createSkippedPkiTest(
  'TC_M_26_CS',
  'Certificate Installation EV - Success',
  'The EV initiates installing a new certificate. The Charging Station forwards the request.',
  'To verify if the Charging Station is able to forward the request to the CSMS.',
);

export const TC_M_27_CS = createSkippedPkiTest(
  'TC_M_27_CS',
  'Certificate Installation EV - Failed',
  'The EV initiates installing a new certificate. The CSMS responds with Failed status.',
  'To verify if the Charging Station is able to handle receiving a Failed status.',
);

export const TC_M_100_CS = createSkippedPkiTest(
  'TC_M_100_CS',
  'Certificate Installation EV - ISO 15118-20 - Success',
  'The EV initiates installing new certificates with ISO 15118-20 support.',
  'To verify if the Charging Station is able to forward the request and accepts multiple contracts.',
);
