// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase } from '../../../../types.js';
import { runInvalidQrTest, stationTotp } from '../../../../qr-test-helpers.js';

export const TC_C_133_CSMS: TestCase = {
  id: 'TC_C_133_CSMS',
  name: 'Ad hoc payment via static or dynamic QR code - invalid totp',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'In order to test that Charging Station supports QR codes.',
  purpose: 'To verify if the CSMS is able to respond correctly when receiving invalid TOTP.',
  // Manual Action: open the QR code URL with the configured station and EVSE,
  // version 1, maxenergy 20000, and an invalid TOTP: the one of an interval
  // long expired, outside the previous/current/next window the CSMS accepts.
  execute: (ctx) =>
    runInvalidQrTest(ctx, 'QR code URL with an invalid TOTP', (values) => ({
      chargingStationId: ctx.stationId,
      evseId: 1,
      totp: stationTotp(values, Date.now() - 10 * Number(values['ValidityTime']) * 1000),
      version: values['TOTPVersion'] ?? '',
      query: 'maxenergy=20000',
    })),
};
