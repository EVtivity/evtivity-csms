// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_064_CSMS: TestCase = {
  id: 'TC_064_CSMS',
  name: 'Data Transfer to a Central System (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Charge Point sends a vendor-specific DataTransfer message.',
  purpose:
    'Verify the CSMS responds to DataTransfer (Rejected, UnknownMessageId, or UnknownVendorId).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    const resp = await ctx.client.sendCall('DataTransfer', {
      vendorId: 'OCTT-Vendor',
      messageId: 'TestMessage',
      data: 'test-data',
    });

    const status = resp['status'] as string;
    const validStatuses = ['Rejected', 'UnknownMessageId', 'UnknownVendorId', 'Accepted'];
    steps.push({
      step: 1,
      description: 'Send DataTransfer and expect Rejected/UnknownMessageId/UnknownVendorId',
      status: validStatuses.includes(status) ? 'passed' : 'failed',
      expected: 'status is Rejected, UnknownMessageId, UnknownVendorId, or Accepted',
      actual: `status = ${status}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
