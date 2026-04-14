// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_A_09_CS: Update Charging Station Password for HTTP Basic Authentication - Accepted
 *
 * The CSMS sends SetVariablesRequest to update BasicAuthPassword.
 * The station accepts the new password and reconnects using it.
 */
export const TC_A_09_CS: CsTestCase = {
  id: 'TC_A_09_CS',
  name: 'Update Charging Station Password for HTTP Basic Authentication - Accepted',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case defines how to use the BasicAuthPassword, the password used to authenticate Charging Station connections.',
  purpose:
    'To verify if the Charging Station is able to accept and store and log the new BasicAuthPassword as configured by the CSMS.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Wait for station to connect and boot
    await ctx.server.waitForMessage('BootNotification', 30_000);

    // Step 1: Send SetVariablesRequest to update BasicAuthPassword
    const newPassword = 'NewTestPassword1234!';
    const setVarRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          variable: { name: 'BasicAuthPassword' },
          component: { name: 'SecurityCtrlr' },
          attributeValue: newPassword,
        },
      ],
    });

    // Step 2: Validate SetVariablesResponse status is Accepted or RebootRequired
    const setVarResult = setVarRes['setVariableResult'] as Record<string, unknown>[] | undefined;
    const attrStatus = setVarResult?.[0]?.['attributeStatus'] as string | undefined;
    const statusAccepted = attrStatus === 'Accepted' || attrStatus === 'RebootRequired';
    steps.push({
      step: 1,
      description:
        'Send SetVariablesRequest for BasicAuthPassword, expect Accepted or RebootRequired',
      status: statusAccepted ? 'passed' : 'failed',
      expected: 'attributeStatus = Accepted or RebootRequired',
      actual: `attributeStatus = ${attrStatus ?? 'not received'}`,
    });

    // Steps 3-4: Station reconnects with new password and upgrades to WebSocket.
    // Steps 5-8: If RebootRequired, station reboots, reconnects, and sends BootNotification.
    // The reconnection and auth validation happen at the transport level.
    if (attrStatus === 'RebootRequired') {
      try {
        const bootPayload = await ctx.server.waitForMessage('BootNotification', 60_000);
        steps.push({
          step: 2,
          description:
            'Station reboots and reconnects with new BasicAuthPassword, sends BootNotification',
          status: bootPayload != null ? 'passed' : 'failed',
          expected: 'BootNotificationRequest received after reboot with new password',
          actual:
            bootPayload != null ? 'BootNotification received' : 'BootNotification not received',
        });
      } catch {
        steps.push({
          step: 2,
          description:
            'Station reboots and reconnects with new BasicAuthPassword, sends BootNotification',
          status: 'failed',
          expected: 'BootNotificationRequest received after reboot with new password',
          actual: 'Timed out waiting for reconnection',
        });
      }
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_A_10_CS: Update Charging Station Password for HTTP Basic Authentication - Rejected
 *
 * The CSMS sends a SetVariablesRequest with an invalid password (less than 16 characters).
 * The station rejects it and continues using the old password.
 */
export const TC_A_10_CS: CsTestCase = {
  id: 'TC_A_10_CS',
  name: 'Update Charging Station Password for HTTP Basic Authentication - Rejected',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case defines how to use the BasicAuthPassword, the password used to authenticate Charging Station connections.',
  purpose: 'To verify if the Charging Station is able to reject the new BasicAuthPassword.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Wait for station to connect and boot
    await ctx.server.waitForMessage('BootNotification', 30_000);

    // Step 1: Send SetVariablesRequest with a password less than 16 characters
    const invalidPassword = 'Short1!';
    const setVarRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          variable: { name: 'BasicAuthPassword' },
          component: { name: 'SecurityCtrlr' },
          attributeValue: invalidPassword,
        },
      ],
    });

    // Step 2: Validate SetVariablesResponse status is Rejected
    const setVarResult = setVarRes['setVariableResult'] as Record<string, unknown>[] | undefined;
    const attrStatus = setVarResult?.[0]?.['attributeStatus'] as string | undefined;
    steps.push({
      step: 1,
      description:
        'Send SetVariablesRequest with invalid BasicAuthPassword (<16 chars), expect Rejected',
      status: attrStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'attributeStatus = Rejected',
      actual: `attributeStatus = ${attrStatus ?? 'not received'}`,
    });

    // Post scenario: Station should still use the old password.
    // Steps 3-5: Station reconnects with old password and boots normally.
    // The old password validation happens at the transport level.

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
