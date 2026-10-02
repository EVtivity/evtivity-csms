// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import {
  getVariable,
  result,
  setVariable,
  step,
  testPki,
  waitForSecurityEvent,
  waitForUpgrade,
} from './helpers.js';

/** SetNetworkProfileRequest for configurationSlot 2 (slot 1 is the active one). */
async function setNetworkProfile(
  ctx: CsTestContext,
  ocppCsmsUrl: string,
  securityProfile: number,
): Promise<string> {
  const res = await ctx.server.sendCommand('SetNetworkProfile', {
    configurationSlot: 2,
    connectionData: {
      messageTimeout: 30,
      ocppCsmsUrl,
      ocppInterface: 'Wired0',
      ocppVersion: 'OCPP20',
      securityProfile,
    },
  });
  return String(res['status']);
}

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
  // The Test System PKI for the upgraded (TLS) connection.
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = testPki(ctx);
    const upgradedProfile = 2;

    // Memory State CertificateInstalled (security profile 1): the CSMS root certificate
    const install = await ctx.server.sendCommand('InstallCertificate', {
      certificateType: 'CSMSRootCertificate',
      certificate: tls.root.pem,
    });
    steps.push(
      step(
        0,
        'Memory State CertificateInstalled: CSMSRootCertificate',
        install['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(install['status'])}`,
      ),
    );

    // The WebSocket server of the upgraded security profile
    const secure = await ctx.startServer({ securityProfile: upgradedProfile });

    // Steps 1-2: SetNetworkProfile for the slot not in use
    const profileStatus = await setNetworkProfile(ctx, secure.url, upgradedProfile);
    steps.push(
      step(
        2,
        'SetNetworkProfileResponse: Accepted',
        profileStatus === 'Accepted',
        'Accepted',
        profileStatus,
      ),
    );

    // Steps 3-4: NetworkConfigurationPriority = new slot, old slot
    const priorityStatus = await setVariable(
      ctx.server,
      'OCPPCommCtrlr',
      'NetworkConfigurationPriority',
      '2,1',
    );
    steps.push(
      step(
        4,
        'SetVariablesResponse NetworkConfigurationPriority: Accepted or RebootRequired',
        priorityStatus === 'Accepted' || priorityStatus === 'RebootRequired',
        'Accepted or RebootRequired',
        String(priorityStatus),
      ),
    );

    // Steps 5-6: Reset OnIdle
    const reset = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    steps.push(
      step(
        6,
        'ResetResponse: Accepted',
        reset['status'] === 'Accepted',
        'Accepted',
        String(reset['status']),
      ),
    );

    // Steps 7-10: the station reconnects with the upgraded profile and boots
    const upgrade = await waitForUpgrade(secure.server, 0, 30_000);
    steps.push(
      step(
        8,
        'Charging Station reconnects using security profile 2 (TLS with Basic Authentication)',
        upgrade?.tls != null && upgrade.authorization != null,
        'TLS connection with an Authorization header',
        upgrade == null ? 'no connection' : `TLS ${String(upgrade.tls?.protocol)}`,
      ),
    );
    if (upgrade == null) return result(steps);
    try {
      await secure.server.waitForMessage('BootNotification', 15_000);
      steps.push(
        step(10, 'Reusable State Booted: BootNotificationRequest', true, 'received', 'received'),
      );
    } catch {
      steps.push(
        step(
          10,
          'Reusable State Booted: BootNotificationRequest',
          false,
          'received',
          'not received',
        ),
      );
      return result(steps);
    }
    // The boot sequence ends with the StartupOfTheDevice security event
    await waitForSecurityEvent(secure.server, ['StartupOfTheDevice', 'ResetOrReboot'], 10_000);

    // Steps 11-12: SecurityCtrlr.SecurityProfile is the upgraded profile
    const profile = await getVariable(secure.server, 'SecurityCtrlr', 'SecurityProfile');
    steps.push(
      step(
        12,
        'GetVariablesResponse SecurityCtrlr.SecurityProfile',
        profile === String(upgradedProfile),
        String(upgradedProfile),
        String(profile),
      ),
    );

    // Steps 13-14: NetworkConfigurationPriority no longer holds the lower-profile slot
    const priority = await getVariable(
      secure.server,
      'OCPPCommCtrlr',
      'NetworkConfigurationPriority',
    );
    const slots = (priority ?? '').split(',').map((s) => s.trim());
    steps.push(
      step(
        14,
        'GetVariablesResponse NetworkConfigurationPriority without the security profile 1 slot',
        priority != null && !slots.includes('1'),
        'does not contain slot 1',
        String(priority),
      ),
    );

    // Steps 15-16: the Test System closes the connection and serves security profile 1
    // only; the station must not connect with security profile 1.
    const plainBefore = ctx.server.upgradeAttempts.length;
    const secureBefore = secure.server.upgradeAttempts.length;
    secure.server.disconnectStation(true);
    await new Promise((r) => setTimeout(r, 10_000));
    steps.push(
      step(
        16,
        'Charging Station does NOT reconnect using security profile 1',
        ctx.server.upgradeAttempts.length === plainBefore,
        'no connection attempt on the security profile 1 server',
        `${String(ctx.server.upgradeAttempts.length - plainBefore)} attempts`,
      ),
    );

    // Steps 17-18: security profile 2 again: the station reconnects
    secure.server.acceptConnections();
    const back = await waitForUpgrade(secure.server, secureBefore, 45_000);
    steps.push(
      step(
        18,
        'Charging Station reconnects using security profile 2',
        back?.tls != null,
        'TLS reconnection',
        back == null ? 'no reconnection' : 'reconnected',
      ),
    );

    return result(steps);
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
  // Connected with security profile 1, no CSMS root certificate installed.
  stationConfig: { securityProfile: 1 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // The second connectionData slot: a security profile 2 server
    const secure = await ctx.startServer({ securityProfile: 2 });

    // Steps 1-2
    const profileStatus = await setNetworkProfile(ctx, secure.url, 2);
    steps.push(
      step(
        2,
        'SetNetworkProfileResponse: Accepted or Rejected',
        profileStatus === 'Accepted' || profileStatus === 'Rejected',
        'Accepted or Rejected',
        profileStatus,
      ),
    );

    // Steps 3-4
    const priorityStatus = await setVariable(
      ctx.server,
      'OCPPCommCtrlr',
      'NetworkConfigurationPriority',
      '2,1',
    );
    steps.push(
      step(
        4,
        'SetVariablesResponse NetworkConfigurationPriority: Rejected',
        priorityStatus === 'Rejected',
        'Rejected',
        String(priorityStatus),
      ),
    );

    return result(steps);
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
  // Security profile 2: a valid CSMS root certificate, no Charging Station certificate.
  stationConfig: { securityProfile: 2 },
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const secure = await ctx.startServer({ securityProfile: 3 });

    // Steps 1-2
    const profileStatus = await setNetworkProfile(ctx, secure.url, 3);
    steps.push(
      step(
        2,
        'SetNetworkProfileResponse: Accepted',
        profileStatus === 'Accepted',
        'Accepted',
        profileStatus,
      ),
    );

    // Steps 3-4
    const priorityStatus = await setVariable(
      ctx.server,
      'OCPPCommCtrlr',
      'NetworkConfigurationPriority',
      '2,1',
    );
    steps.push(
      step(
        4,
        'SetVariablesResponse NetworkConfigurationPriority: Rejected',
        priorityStatus === 'Rejected',
        'Rejected',
        String(priorityStatus),
      ),
    );

    return result(steps);
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
  tls: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // The second connectionData slot: a security profile 1 server
    const plain = await ctx.startServer({ securityProfile: 1 });

    // Steps 1-2: SetNetworkProfile with security profile 1
    const status = await setNetworkProfile(ctx, plain.url, 1);
    steps.push(
      step(
        2,
        'SetNetworkProfileResponse for security profile 1 (downgrade): Rejected',
        status === 'Rejected',
        'Rejected',
        status,
      ),
    );

    return result(steps);
  },
};
