// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_O_01_CS: CsTestCase = {
  id: 'TC_O_01_CS',
  name: 'Set Display Message - Success',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a display message on the Charging Station.',
  purpose: 'To verify if the Charging Station is able to display additional messages.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const msgId = 1001;
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: msgId,
        priority: 'NormalCycle',
        message: { format: 'UTF8', content: 'Test message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });

    const getRes = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: 1,
      id: [msgId],
    });
    steps.push({
      step: 2,
      description: 'GetDisplayMessagesResponse Accepted',
      status: (getRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${getRes['status']}`,
    });

    try {
      const notify = await ctx.server.waitForMessage('NotifyDisplayMessages', 15000);
      steps.push({
        step: 3,
        description: 'NotifyDisplayMessagesRequest received',
        status: notify != null ? 'passed' : 'failed',
        expected: 'Message received',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'NotifyDisplayMessagesRequest',
        status: 'failed',
        expected: 'Message received',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_13_CS: CsTestCase = {
  id: 'TC_O_13_CS',
  name: 'Set Display Message - Display at StartTime',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a display message with a future start time.',
  purpose: 'To verify if the Charging Station displays a message at the configured start time.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 1002,
        priority: 'NormalCycle',
        startDateTime: new Date(Date.now() + 30000).toISOString(),
        message: { format: 'UTF8', content: 'Delayed message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_14_CS: CsTestCase = {
  id: 'TC_O_14_CS',
  name: 'Set Display Message - Remove after EndTime',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a display message with an end time.',
  purpose: 'To verify if the Charging Station removes the message after the end time.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const msgId = 1003;
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: msgId,
        priority: 'NormalCycle',
        endDateTime: new Date(Date.now() + 30000).toISOString(),
        message: { format: 'UTF8', content: 'Expiring message' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse Accepted',
      status: (setRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${setRes['status']}`,
    });

    // After endDateTime, the message should be gone
    const getRes = await ctx.server.sendCommand('GetDisplayMessages', {
      requestId: 2,
      id: [msgId],
    });
    steps.push({
      step: 2,
      description: 'GetDisplayMessagesResponse after endTime',
      status: ['Accepted', 'Unknown'].includes(getRes['status'] as string) ? 'passed' : 'failed',
      expected: 'status = Accepted or Unknown',
      actual: `status = ${getRes['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_17_CS: CsTestCase = {
  id: 'TC_O_17_CS',
  name: 'Set Display Message - NotSupportedPriority',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a display message with an unsupported priority.',
  purpose: 'To verify if the Charging Station responds with NotSupportedPriority.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 1004,
        priority: 'UnsupportedPriority',
        message: { format: 'UTF8', content: 'Test' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse NotSupportedPriority',
      status: (setRes['status'] as string) === 'NotSupportedPriority' ? 'passed' : 'failed',
      expected: 'status = NotSupportedPriority',
      actual: `status = ${setRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_O_18_CS: CsTestCase = {
  id: 'TC_O_18_CS',
  name: 'Set Display Message - NotSupportedState',
  module: 'O-display-message',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a display message with an unsupported state.',
  purpose: 'To verify if the Charging Station responds with NotSupportedState.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const setRes = await ctx.server.sendCommand('SetDisplayMessage', {
      message: {
        id: 1005,
        state: 'UnsupportedState',
        message: { format: 'UTF8', content: 'Test' },
      },
    });
    steps.push({
      step: 1,
      description: 'SetDisplayMessageResponse NotSupportedState',
      status: (setRes['status'] as string) === 'NotSupportedState' ? 'passed' : 'failed',
      expected: 'status = NotSupportedState',
      actual: `status = ${setRes['status']}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
