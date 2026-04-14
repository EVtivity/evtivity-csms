// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_G_20_CS: CsTestCase = {
  id: 'TC_G_20_CS',
  name: 'Connector status Notification - Lock Failure',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the EV Driver is prevented from starting a charge session at the Charging Station when a connector lock failure occurs.',
  purpose:
    'To verify if the Charging Station does not start charging and notifies the CSMS when a connector is not properly locked.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Simulate a connector lock failure on EVSE 1
    await ctx.station.simulateLockFailure(1, 1);

    // Step 2: Wait for NotifyEventRequest with ConnectorPlugRetentionLock Problem
    const eventMsg = await ctx.server.waitForMessage('NotifyEvent', 10000);
    const eventData = (
      (eventMsg as Record<string, unknown>)['eventData'] as Record<string, unknown>[]
    )?.[0];
    const trigger = eventData?.['trigger'] as string;
    const component = eventData?.['component'] as Record<string, unknown>;
    const componentName = component?.['name'] as string;
    const variable = eventData?.['variable'] as Record<string, unknown>;
    const variableName = variable?.['name'] as string;
    const actualValue = eventData?.['actualValue'] as string;

    steps.push({
      step: 2,
      description:
        'NotifyEventRequest - trigger must be Delta, component.name must be ConnectorPlugRetentionLock, variable.name must be Problem, actualValue must be true',
      status:
        trigger === 'Delta' &&
        componentName === 'ConnectorPlugRetentionLock' &&
        variableName === 'Problem' &&
        actualValue === 'true'
          ? 'passed'
          : 'failed',
      expected:
        'trigger = Delta, component.name = ConnectorPlugRetentionLock, variable.name = Problem, actualValue = true',
      actual: `trigger = ${trigger}, component.name = ${componentName}, variable.name = ${variableName}, actualValue = ${actualValue}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
