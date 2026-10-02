// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase } from '../../../../types.js';
import { runInvalidQrTest, stationTotp } from '../../../../qr-test-helpers.js';

export const TC_C_132_CSMS: TestCase = {
  id: 'TC_C_132_CSMS',
  name: 'Ad hoc payment via static or dynamic QR code - invalid URL parameters',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'In order to test that CSMS supports QR codes',
  purpose: 'To verify if the CSMS is able to respond correctly when receiving invalid parameters.',
  // Manual Action: open the QR code URL with {chargingstationid} omitted, a valid
  // TOTP, the configured EVSE, version 1, and maxenergy 20000.
  execute: (ctx) =>
    runInvalidQrTest(ctx, 'QR code URL with chargingstationid omitted', (values) => ({
      evseId: 1,
      totp: stationTotp(values),
      version: values['TOTPVersion'] ?? '',
      query: 'maxenergy=20000',
    })),
};
