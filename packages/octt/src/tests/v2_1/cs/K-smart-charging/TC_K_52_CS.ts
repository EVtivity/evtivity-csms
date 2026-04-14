// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const handler = async (action: string) => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'ReportChargingProfiles') return {};
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return {};
  if (action === 'NotifyChargingLimit') return {};
  if (action === 'NotifyEVChargingNeeds') return { status: 'Accepted' };
  if (action === 'NotifyEVChargingSchedule') return { status: 'Accepted' };
  if (action === 'NotifyPriorityCharging') return {};
  if (action === 'PullDynamicScheduleUpdate')
    return { status: 'Accepted', scheduleUpdate: { limit: 6 } };
  return {};
};

/** TC_K_52_CS: EMS Control - Set / Update External Charging Limit */
export const TC_K_52_CS: CsTestCase = {
  id: 'TC_K_52_CS',
  name: 'EMS Control - Set / Update External Charging Limit',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'A charging schedule or charging limit has been set by an external system.',
  purpose: 'To verify if the charging station reports an external charging limit correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install a ChargingStationExternalConstraints profile
    try {
      const installRes = await ctx.server.sendCommand('SetChargingProfile', {
        evseId: 0,
        chargingProfile: {
          id: 100,
          stackLevel: 0,
          chargingProfilePurpose: 'ChargingStationExternalConstraints',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 100,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 32, numberPhases: 3 }],
            },
          ],
        },
      });
      const installStatus = (installRes as Record<string, unknown>).status;
      steps.push({
        step: 1,
        description: 'Precondition: Install ChargingStationExternalConstraints profile',
        status: installStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(installStatus)}`,
      });
    } catch (err) {
      steps.push({
        step: 1,
        description: 'Precondition: Install ExternalConstraints profile',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'ChargingStationExternalConstraints' },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const report = await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      const profiles = (report as Record<string, unknown>).chargingProfile;
      const profileArr = Array.isArray(profiles) ? profiles : [profiles];
      const cp = profileArr[0] as Record<string, unknown> | undefined;
      const purpose = cp?.chargingProfilePurpose;
      steps.push({
        step: 3,
        description: 'ReportChargingProfiles with ExternalConstraints',
        status: purpose === 'ChargingStationExternalConstraints' ? 'passed' : 'failed',
        expected: 'ChargingStationExternalConstraints',
        actual: `purpose: ${String(purpose)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_53_CS: Charging with load leveling based on HLC - Success */
export const TC_K_53_CS: CsTestCase = {
  id: 'TC_K_53_CS',
  name: 'Charging with load leveling based on HLC - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'ISO15118 AC/DC charging with load leveling based on High Level Communication.',
  purpose:
    'To verify if the Charging Station performs load leveling when it receives charging needs.',
  execute: async (_ctx) => {
    // Requires ISO 15118 HLC support (NotifyEVChargingNeeds)
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_54_CS: Charging with load leveling based on HLC - No SASchedule (rejected) */
export const TC_K_54_CS: CsTestCase = {
  id: 'TC_K_54_CS',
  name: 'Charging with HLC - No SASchedule (rejected)',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'ISO15118 charging with HLC when the CSMS rejects the charging needs.',
  purpose: 'To verify if the Charging Station handles a Rejected status from the CSMS.',
  execute: async (_ctx) => {
    // Requires ISO 15118 HLC support (NotifyEVChargingNeeds)
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_56_CS: Charging with load leveling based on HLC - Offline */
export const TC_K_56_CS: CsTestCase = {
  id: 'TC_K_56_CS',
  name: 'Charging with HLC - Offline',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'ISO15118 charging with HLC when the station goes offline.',
  purpose:
    'To verify if the Charging Station performs load leveling offline using TxDefaultProfile.',
  execute: async (_ctx) => {
    // Requires ISO 15118 HLC support (NotifyEVChargingNeeds, offline HLC)
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_113_CS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by CSMS */
export const TC_K_113_CS: CsTestCase = {
  id: 'TC_K_113_CS',
  name: 'Renegotiating Charging Schedule ISO 15118-20 - CSMS initiated',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS initiates charging schedule renegotiation via ISO 15118-20.',
  purpose:
    'To verify if the Charging Station performs load leveling when it receives a renegotiate request from CSMS.',
  execute: async (_ctx) => {
    // Requires ISO 15118-20 renegotiation support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_57_CS: Renegotiating a Charging Schedule ISO 15118-2 - Initiated by EV */
export const TC_K_57_CS: CsTestCase = {
  id: 'TC_K_57_CS',
  name: 'Renegotiating Charging Schedule ISO 15118-2 - EV initiated',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV signals the Charging Station that it wants to renegotiate.',
  purpose:
    'To verify if the Charging Station performs load leveling on EV-initiated renegotiation.',
  execute: async (_ctx) => {
    // Requires EV manual action for RenegotiateChargingLimits
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_58_CS: Renegotiating a Charging Schedule ISO 15118-2 - Initiated by CSMS */
export const TC_K_58_CS: CsTestCase = {
  id: 'TC_K_58_CS',
  name: 'Renegotiating Charging Schedule ISO 15118-2 - CSMS initiated',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS initiates charging schedule renegotiation via ISO 15118-2.',
  purpose:
    'To verify if the Charging Station performs load leveling on CSMS-initiated renegotiation.',
  execute: async (_ctx) => {
    // Requires ISO 15118-2 HLC support (NotifyEVChargingSchedule renegotiation)
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_114_CS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV */
export const TC_K_114_CS: CsTestCase = {
  id: 'TC_K_114_CS',
  name: 'Renegotiating Charging Schedule ISO 15118-20 - EV initiated',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV initiates renegotiation via ISO 15118-20.',
  purpose: 'To verify if the Charging Station handles EV-initiated renegotiation via ISO 15118-20.',
  execute: async (_ctx) => {
    // Requires ISO 15118-20 renegotiation support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_115_CS: ISO 15118-20 Dynamic Control Mode - Success */
export const TC_K_115_CS: CsTestCase = {
  id: 'TC_K_115_CS',
  name: 'ISO 15118-20 Dynamic Control Mode - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV requests DynamicControl via ISO 15118-20.',
  purpose: 'To verify if the Charging Station supports DynamicControl when the EV requests it.',
  execute: async (_ctx) => {
    // Requires ISO 15118-20 dynamic control mode support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_116_CS: Renegotiating ISO 15118-20 - Adjusting charging schedule when energy needs change */
export const TC_K_116_CS: CsTestCase = {
  id: 'TC_K_116_CS',
  name: 'Renegotiating ISO 15118-20 - Adjusting schedule on energy needs',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The EV adjusts energy needs and triggers multiple renegotiations.',
  purpose:
    'To verify if the Charging Station handles multiple renegotiations with changing energy needs.',
  execute: async (_ctx) => {
    // Requires ISO 15118-20 renegotiation support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_118_CS: Priority Charging - Requesting priority charging remotely */
export const TC_K_118_CS: CsTestCase = {
  id: 'TC_K_118_CS',
  name: 'Priority Charging - Remote',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests priority charging for a transaction.',
  purpose: 'To verify if the Charging station supports priority charging initiated from CSMS.',
  execute: async (_ctx) => {
    // Requires PriorityCharging profile purpose support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_119_CS: Priority Charging - Requesting priority charging locally */
export const TC_K_119_CS: CsTestCase = {
  id: 'TC_K_119_CS',
  name: 'Priority Charging - Local',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station requests priority charging locally.',
  purpose: 'To verify if the Charging station supports priority charging initiated locally.',
  execute: async (_ctx) => {
    // Requires PriorityCharging profile purpose support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_120_CS: EMS Control - Smart Charging with EMS and LocalGeneration */
export const TC_K_120_CS: CsTestCase = {
  id: 'TC_K_120_CS',
  name: 'EMS Control - Smart Charging with EMS and LocalGeneration',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Shows how locally available capacity can be taken into account.',
  purpose:
    'To verify if the Charging Station informs the CSMS when capacity is throttled by a local EMS.',
  execute: async (_ctx) => {
    // Requires EMS and LocalGeneration support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_121_CS: Dynamic charging profiles from CSMS - Pull */
export const TC_K_121_CS: CsTestCase = {
  id: 'TC_K_121_CS',
  name: 'Dynamic charging profiles from CSMS - Pull',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sets a Dynamic profile and the station pulls updates.',
  purpose:
    'To verify if the Charging Station supports pulling DynamicControl profiles from the CSMS.',
  execute: async (_ctx) => {
    // Requires Dynamic charging profile support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_122_CS: Dynamic charging profiles from CSMS - Push */
export const TC_K_122_CS: CsTestCase = {
  id: 'TC_K_122_CS',
  name: 'Dynamic charging profiles from CSMS - Push',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS pushes dynamic profile updates to the station.',
  purpose:
    'To verify if the Charging Station supports DynamicControl profiles with CSMS pushing updates.',
  execute: async (_ctx) => {
    // Requires Dynamic charging profile support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_123_CS: Dynamic charging profiles from CSMS - validations */
export const TC_K_123_CS: CsTestCase = {
  id: 'TC_K_123_CS',
  name: 'Dynamic charging profiles from CSMS - validations',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS validates Dynamic charging profile constraints.',
  purpose: 'To verify if the Charging Station validates Dynamic charging profile constraints.',
  execute: async (_ctx) => {
    // Requires Dynamic charging profile support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_124_CS: Dynamic charging profiles by external system - No Dynamic profile configured */
export const TC_K_124_CS: CsTestCase = {
  id: 'TC_K_124_CS',
  name: 'Dynamic profiles by external system - No Dynamic profile configured',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'An external system sets charging limits on the station.',
  purpose:
    'To verify if the Charging Station reports correct updates when being controlled by an external system.',
  execute: async (_ctx) => {
    // Requires Dynamic charging profile and EMS support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/** TC_K_125_CS: Dynamic charging profiles by external system - Dynamic profile configured */
export const TC_K_125_CS: CsTestCase = {
  id: 'TC_K_125_CS',
  name: 'Dynamic profiles by external system - Dynamic profile configured',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'An external system sets charging limits when Dynamic profiles are already configured.',
  purpose:
    'To verify if the Charging Station informs the CSMS when capacity is throttled by a locally connected system.',
  execute: async (_ctx) => {
    // Requires Dynamic charging profile and EMS support
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
