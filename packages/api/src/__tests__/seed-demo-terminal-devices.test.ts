// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The demo seed stores the vendor, model, serial number and firmware of its
// two payment terminals (the database package does not import the terminal
// package): they must be what the simulated devices report, so the status
// poll never changes them and a terminal registered from the device picker
// shows the same values.

import { describe, it, expect } from 'vitest';
import { SIMULATED_DEVICES } from '@evtivity/payment-terminals';
import { TERMINAL_DEMO } from '@evtivity/database/src/seed-demo-features.js';

describe('demo payment terminal devices', () => {
  it('match the simulated devices they use', () => {
    for (const demo of Object.values(TERMINAL_DEMO.devices)) {
      const device = SIMULATED_DEVICES.find((d) => d.providerDeviceId === demo.providerDeviceId);
      expect(device, demo.providerDeviceId).toBeDefined();
      expect({
        vendor: device?.vendor,
        model: device?.model,
        serialNumber: device?.serialNumber,
        firmwareVersion: device?.firmwareVersion,
        online: device?.online,
        iccid: device?.iccid,
      }).toEqual({
        vendor: demo.vendor,
        model: demo.model,
        serialNumber: demo.serialNumber,
        firmwareVersion: demo.firmwareVersion,
        online: true,
        // The demo SIM is entered on the terminal page, not reported.
        iccid: null,
      });
    }
  });

  it('report the vendor, a serial number and a firmware version on every simulated device', () => {
    for (const device of SIMULATED_DEVICES) {
      expect(device.vendor).toBe('ID TECH');
      expect(device.serialNumber).toMatch(/^(6825|7200)SIM\d{6}$/);
      expect(device.firmwareVersion).toMatch(/^\d+\.\d{2}\.\d{3}$/);
    }
    const serials = SIMULATED_DEVICES.map((d) => d.serialNumber);
    expect(new Set(serials).size).toBe(serials.length);
  });
});
