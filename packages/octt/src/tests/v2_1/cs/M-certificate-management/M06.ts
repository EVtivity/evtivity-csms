// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

const createSkippedCertStatusTest = (
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

export const TC_M_24_CS = createSkippedCertStatusTest(
  'TC_M_24_CS',
  'Get Charging Station Certificate status - Success',
  'The Charging Station requests the CSMS to get the status of a V2G Charging Station certificate.',
  'To verify if the Charging Station is able to request the status of a V2G Charging Station certificate.',
);

export const TC_M_25_CS = createSkippedCertStatusTest(
  'TC_M_25_CS',
  'Get Charging Station Certificate status - Rejected',
  'The Charging Station requests certificate status and receives a Failed response.',
  'To verify if the Charging Station handles receiving a rejected status.',
);
