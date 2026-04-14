// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_A_19_CS: Upgrade Charging Station Security Profile - Accepted
 *
 * The CSMS updates the connection details on the Charging Station to increase the
 * security profile level. Station reconnects at the higher profile.
 */
export const TC_A_19_CS: CsTestCase = {
  id: 'TC_A_19_CS',
  name: 'Upgrade Charging Station Security Profile - Accepted',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS updates the connection details on the Charging Station, to increase the security profile level.',
  purpose:
    'To verify if the Charging Station is able to increase the security profile level when configured to do so by the CSMS.',
  stationConfig: { securityProfile: 1 },
  // Skipped: requires certificate infrastructure for security profile upgrade and reconnection
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_A_20_CS: Upgrade Charging Station Security Profile - No valid CSMSRootCertificate installed
 *
 * The CSMS tries to upgrade the security profile when no valid CSMS root certificate
 * is installed. The station rejects the NetworkConfigurationPriority change.
 */
export const TC_A_20_CS: CsTestCase = {
  id: 'TC_A_20_CS',
  name: 'Upgrade Charging Station Security Profile - No valid CSMSRootCertificate installed',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to change the connectionData at the Charging Station. By doing this it is able to upgrade the security profile.',
  purpose:
    'To verify if the Charging Station is able to reject upgrading to a higher security profile when it does not have a valid CSMS root certificate installed.',
  stationConfig: { securityProfile: 1 },
  // Skipped: requires CSMS root certificate validation on station side
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_A_21_CS: Upgrade Charging Station Security Profile - No valid ChargingStationCertificate installed
 *
 * The CSMS tries to upgrade to security profile 3 when no valid charging station
 * certificate is installed. The station rejects the NetworkConfigurationPriority change.
 */
export const TC_A_21_CS: CsTestCase = {
  id: 'TC_A_21_CS',
  name: 'Upgrade Charging Station Security Profile - No valid ChargingStationCertificate installed',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to change the connectionData at the Charging Station. By doing this it is able to upgrade the security profile.',
  purpose:
    'To verify if the Charging Station is able to reject upgrading to security profile 3 when it does not have a valid charging station certificate.',
  stationConfig: { securityProfile: 2 },
  // Skipped: requires station certificate validation for SP3 upgrade rejection
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_A_22_CS: Upgrade Charging Station Security Profile - Downgrade security profile - Rejected
 *
 * The CSMS tries to downgrade the security profile to 1. The station rejects.
 */
export const TC_A_22_CS: CsTestCase = {
  id: 'TC_A_22_CS',
  name: 'Upgrade Charging Station Security Profile - Downgrade security profile - Rejected',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS is able to change the connectionData at the Charging Station. It tries to downgrade the security profile.',
  purpose: 'To verify if the Charging Station is able to reject downgrading to security profile 1.',
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Wait for station to connect and boot
    await ctx.server.waitForMessage('BootNotification', 30_000);

    // Step 1: Send SetNetworkProfileRequest with securityProfile 1 (downgrade)
    const setNetRes = await ctx.server.sendCommand('SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        messageTimeout: 30,
        ocppCsmsUrl: 'ws://127.0.0.1:9999',
        ocppInterface: 'Wired0',
        ocppVersion: 'OCPP20',
        securityProfile: 1,
      },
    });

    // Step 2: Validate SetNetworkProfileResponse status Rejected
    const netStatus = setNetRes['status'] as string | undefined;
    steps.push({
      step: 1,
      description:
        'Send SetNetworkProfileRequest with securityProfile 1 (downgrade attempt), expect Rejected',
      status: netStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${netStatus ?? 'not received'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
