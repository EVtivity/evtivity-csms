// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_001_CSMS: TestCase = {
  id: 'TC_001_CSMS',
  name: 'Cold Boot Charging Station (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Verify the CSMS handles a BootNotification from an OCPP 1.6 station.',
  purpose: 'The CSMS must accept BootNotification and return heartbeat interval.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const response = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const status = response['status'] as string;
    steps.push({
      step: 1,
      description: 'Send BootNotification (OCPP 1.6 format)',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${status}`,
    });

    const interval = response['interval'] as number;
    steps.push({
      step: 2,
      description: 'Response contains heartbeat interval',
      status: typeof interval === 'number' && interval > 0 ? 'passed' : 'failed',
      expected: 'interval > 0',
      actual: `interval = ${String(interval)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
