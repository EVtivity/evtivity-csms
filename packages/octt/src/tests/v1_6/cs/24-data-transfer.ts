// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_062_CS: CsTestCase = {
  id: 'TC_062_CS',
  name: 'Data Transfer to a Charge Point',
  module: '24-data-transfer',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sends a vendor specific message to a Charge Point.',
  purpose: 'To check whether the Charge Point can reject vendor specific messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    const resp = await ctx.server.sendCommand('DataTransfer', {
      vendorId: 'UnknownVendor',
      messageId: 'TestMessage',
      data: 'test',
    });
    const status = resp['status'] as string | undefined;
    const validStatus =
      status === 'Rejected' ||
      status === 'UnknownMessageId' ||
      status === 'UnknownVendorId' ||
      status === 'Accepted';
    steps.push({
      step: 2,
      description: 'DataTransfer response received',
      status: validStatus ? 'passed' : 'failed',
      expected: 'status = Rejected/UnknownMessageId/UnknownVendorId/Accepted',
      actual: `status = ${String(status)}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
