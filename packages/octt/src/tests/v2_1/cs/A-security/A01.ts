// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { newTestPassword } from '../../../../security-test-helpers.js';
import { basicAuthHeader, result, setVariable, step, waitForUpgrade } from './helpers.js';

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

    // Step 1: SetVariablesRequest with a new BasicAuthPassword (a valid passwordString)
    const newPassword = newTestPassword(24);
    const upgradesBefore = ctx.server.upgradeAttempts.length;
    const attrStatus = await setVariable(
      ctx.server,
      'SecurityCtrlr',
      'BasicAuthPassword',
      newPassword,
    );

    // Step 2: status Accepted or RebootRequired
    steps.push(
      step(
        2,
        'SetVariablesResponse for BasicAuthPassword: Accepted or RebootRequired',
        attrStatus === 'Accepted' || attrStatus === 'RebootRequired',
        'attributeStatus = Accepted or RebootRequired',
        `attributeStatus = ${attrStatus ?? 'not received'}`,
      ),
    );

    // Steps 3-4: the station connects again with the new password
    const upgrade = await waitForUpgrade(ctx.server, upgradesBefore, 30_000);
    steps.push(
      step(
        3,
        'HTTP upgrade request with Authorization Basic Base64(<ChargingStationId>:<NEW password>)',
        upgrade?.authorization === basicAuthHeader(ctx.stationId, newPassword),
        'Basic Base64(<ChargingStationId>:<new password>)',
        upgrade == null ? 'no reconnection in 30 s' : (upgrade.authorization ?? 'no header'),
      ),
    );

    // Steps 5-8: only when the station answered RebootRequired
    if (attrStatus === 'RebootRequired') {
      const boot = await ctx.server.waitForMessage('BootNotification', 30_000);
      steps.push(
        step(5, 'BootNotificationRequest after the reboot', boot != null, 'received', 'received'),
      );
    }

    return result(steps);
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

    // Step 1: SetVariablesRequest with a password of less than 16 characters
    const attrStatus = await setVariable(
      ctx.server,
      'SecurityCtrlr',
      'BasicAuthPassword',
      newTestPassword(12),
    );

    // Step 2: status Rejected
    steps.push(
      step(
        2,
        'SetVariablesResponse for a BasicAuthPassword of less than 16 characters: Rejected',
        attrStatus === 'Rejected',
        'attributeStatus = Rejected',
        `attributeStatus = ${attrStatus ?? 'not received'}`,
      ),
    );

    // Steps 3-5: the station connects with the OLD password (Reusable State Booted,
    // Manual Action: power cycle)
    const upgradesBefore = ctx.server.upgradeAttempts.length;
    await ctx.station.simulatePowerCycle('PowerUp');
    const upgrade = await waitForUpgrade(ctx.server, upgradesBefore, 30_000);
    steps.push(
      step(
        3,
        'HTTP upgrade request with Authorization Basic Base64(<ChargingStationId>:<OLD password>)',
        upgrade?.authorization === basicAuthHeader(ctx.stationId, ctx.security.password),
        'Basic Base64(<ChargingStationId>:<configured password>)',
        upgrade == null ? 'no reconnection in 30 s' : (upgrade.authorization ?? 'no header'),
      ),
    );
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push(
      step(
        5,
        'Reusable State Booted: BootNotificationRequest',
        boot != null,
        'received',
        'received',
      ),
    );

    return result(steps);
  },
};
