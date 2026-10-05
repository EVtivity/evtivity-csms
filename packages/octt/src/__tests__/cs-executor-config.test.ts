// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildCssConfigDefaults } from '@evtivity/lib';
import { CS_TEST_RECONNECT_BACK_OFF } from '../cs-executor.js';

describe('CS test station reconnect back-off', () => {
  const defaults = new Map(
    buildCssConfigDefaults({
      ocppProtocol: 'ocpp2.1',
      stationId: 'OCTT-CS-TEST',
      vendorName: 'OCTT',
      model: 'OCTT-Virtual',
      serialNumber: 'OCTT-SN-001',
      firmwareVersion: '1.0.0',
      securityProfile: 0,
      targetUrl: 'ws://localhost:9999',
      evses: [],
    }).map((d) => [d.key, d.value]),
  );

  it('overrides factory keys of the 2.1 device model', () => {
    for (const key of Object.keys(CS_TEST_RECONNECT_BACK_OFF)) {
      expect(defaults.has(key), key).toBe(true);
    }
  });

  it('keeps the 10 s plus up to 5 s back-off the CS test timings assume', () => {
    expect(CS_TEST_RECONNECT_BACK_OFF).toEqual({
      'OCPPCommCtrlr.RetryBackOffWaitMinimum': '10',
      'OCPPCommCtrlr.RetryBackOffRandomRange': '5',
      'OCPPCommCtrlr.RetryBackOffRepeatTimes': '3',
    });
  });
});
