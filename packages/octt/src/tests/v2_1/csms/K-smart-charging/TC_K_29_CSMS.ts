// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper for GetChargingProfiles tests
async function bootStation(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
}

function makeGetChargingProfilesTest(
  id: string,
  name: string,
  description: string,
  purpose: string,
  validateRequest: (payload: Record<string, unknown>, steps: StepResult[]) => void,
  _respondAccepted: (payload: Record<string, unknown>) => Record<string, unknown>,
  triggerParams?: Record<string, unknown>,
): TestCase {
  return {
    id,
    name,
    module: 'K-smart-charging',
    version: 'ocpp2.1',
    sut: 'csms',
    description,
    purpose,
    execute: async (ctx) => {
      const steps: StepResult[] = [];
      await bootStation(ctx);

      let receivedGet = false;
      let getPayload: Record<string, unknown> = {};
      let requestId = 0;

      ctx.client.setIncomingCallHandler(
        async (_messageId: string, action: string, payload: Record<string, unknown>) => {
          if (action === 'GetChargingProfiles') {
            receivedGet = true;
            getPayload = payload;
            requestId = (payload['requestId'] as number) ?? 1;
            return { status: 'Accepted' };
          }
          return {};
        },
      );

      if (ctx.triggerCommand != null) {
        await ctx.triggerCommand('v21', 'GetChargingProfiles', {
          stationId: ctx.stationId,
          requestId: 1,
          chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' },
          ...triggerParams,
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }

      steps.push({
        step: 1,
        description: 'CSMS sends GetChargingProfilesRequest',
        status: receivedGet ? 'passed' : 'failed',
        expected: 'GetChargingProfilesRequest received',
        actual: receivedGet ? 'Received' : 'Not received',
      });

      if (receivedGet) {
        validateRequest(getPayload, steps);

        // Send ReportChargingProfilesRequest
        const reportRes = await ctx.client.sendCall('ReportChargingProfiles', {
          requestId,
          chargingLimitSource: 'CSO',
          evseId: 1,
          chargingProfile: [
            {
              id: 1,
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Absolute',
              chargingSchedule: [
                {
                  id: 1,
                  chargingRateUnit: 'A',
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: 10.0 }],
                },
              ],
            },
          ],
          tbc: false,
        });

        steps.push({
          step: steps.length + 1,
          description: 'Send ReportChargingProfilesRequest',
          status: 'passed',
          expected: 'ReportChargingProfilesResponse received',
          actual: `Response keys: ${Object.keys(reportRes).join(', ')}`,
        });
      }

      return {
        status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
        durationMs: 0,
        steps,
      };
    },
  };
}

/** TC_K_29_CSMS: Get Charging Profile - EvseId 0 */
export const TC_K_29_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_29_CSMS',
  'Get Charging Profile - EvseId 0',
  'With the GetChargingProfilesRequest the CSMS can ask a Charging Station to report charging profiles.',
  'To verify if the CSMS is able to request charging profiles installed on the charging station itself.',
  (payload, steps) => {
    const evseId = payload['evseId'];
    steps.push({
      step: 2,
      description: 'evseId must be 0',
      status: evseId === 0 ? 'passed' : 'failed',
      expected: 'evseId = 0',
      actual: `evseId = ${String(evseId)}`,
    });
  },
  () => ({ status: 'Accepted' }),
  { evseId: 0 },
);

/** TC_K_30_CSMS: Get Charging Profile - EvseId > 0 */
export const TC_K_30_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_30_CSMS',
  'Get Charging Profile - EvseId > 0',
  'With the GetChargingProfilesRequest the CSMS can ask a Charging Station to report charging profiles.',
  'To verify if the CSMS is able to request charging profiles installed on a specific EVSE.',
  (payload, steps) => {
    const evseId = payload['evseId'] as number;
    steps.push({
      step: 2,
      description: 'evseId must be > 0',
      status: evseId != null && evseId > 0 ? 'passed' : 'failed',
      expected: 'evseId > 0',
      actual: `evseId = ${String(evseId)}`,
    });
  },
  () => ({ status: 'Accepted' }),
  { evseId: 1 },
);

/** TC_K_31_CSMS: Get Charging Profile - No EvseId */
export const TC_K_31_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_31_CSMS',
  'Get Charging Profile - No EvseId',
  'With the GetChargingProfilesRequest the CSMS can ask a Charging Station to report all charging profiles.',
  'To verify if the CSMS is able to request all charging profiles installed on a charger.',
  (payload, steps) => {
    const evseId = payload['evseId'];
    steps.push({
      step: 2,
      description: 'evseId must be omitted',
      status: evseId == null ? 'passed' : 'failed',
      expected: 'evseId omitted',
      actual: evseId == null ? 'omitted' : `evseId = ${String(evseId)}`,
    });
  },
  () => ({ status: 'Accepted' }),
);

/** TC_K_32_CSMS: Get Charging Profile - chargingProfileId */
export const TC_K_32_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_32_CSMS',
  'Get Charging Profile - chargingProfileId',
  'With the GetChargingProfilesRequest the CSMS can request a specific charging profile.',
  'To verify if the CSMS is able to request a specific charging profile.',
  (payload, steps) => {
    const criteria = payload['chargingProfile'] as Record<string, unknown> | undefined;
    const profileId = criteria?.['chargingProfileId'];
    steps.push({
      step: 2,
      description: 'chargingProfile.chargingProfileId must be present',
      status: profileId != null ? 'passed' : 'failed',
      expected: 'chargingProfileId present',
      actual: profileId != null ? `chargingProfileId = ${String(profileId)}` : 'omitted',
    });
  },
  () => ({ status: 'Accepted' }),
  { chargingProfile: { chargingProfileId: [1] } },
);

/** TC_K_33_CSMS: Get Charging Profile - EvseId > 0 + stackLevel */
export const TC_K_33_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_33_CSMS',
  'Get Charging Profile - EvseId > 0 + stackLevel',
  'With the GetChargingProfilesRequest the CSMS can request profiles with a specific stackLevel.',
  'To verify if the CSMS is able to request charging profiles with a specific stackLevel on a specific EVSE.',
  (payload, steps) => {
    const criteria = payload['chargingProfile'] as Record<string, unknown> | undefined;
    const stackLevel = criteria?.['stackLevel'];
    steps.push({
      step: 2,
      description: 'chargingProfile.stackLevel must be present',
      status: stackLevel != null ? 'passed' : 'failed',
      expected: 'stackLevel present',
      actual: stackLevel != null ? `stackLevel = ${String(stackLevel)}` : 'omitted',
    });
  },
  () => ({ status: 'Accepted' }),
  { evseId: 1, chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 } },
);

/** TC_K_34_CSMS: Get Charging Profile - EvseId > 0 + chargingLimitSource */
export const TC_K_34_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_34_CSMS',
  'Get Charging Profile - EvseId > 0 + chargingLimitSource',
  'With the GetChargingProfilesRequest the CSMS can request profiles with a specific chargingLimitSource.',
  'To verify if the CSMS is able to request charging profiles with a specific chargingLimitSource on a specific EVSE.',
  (payload, steps) => {
    const criteria = payload['chargingProfile'] as Record<string, unknown> | undefined;
    const limitSource = criteria?.['chargingLimitSource'];
    steps.push({
      step: 2,
      description: 'chargingProfile.chargingLimitSource must be present',
      status: limitSource != null ? 'passed' : 'failed',
      expected: 'chargingLimitSource present',
      actual: limitSource != null ? `chargingLimitSource = ${String(limitSource)}` : 'omitted',
    });
  },
  () => ({ status: 'Accepted' }),
  {
    evseId: 1,
    chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', chargingLimitSource: ['CSO'] },
  },
);

/** TC_K_35_CSMS: Get Charging Profile - EvseId > 0 + chargingProfilePurpose */
export const TC_K_35_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_35_CSMS',
  'Get Charging Profile - EvseId > 0 + chargingProfilePurpose',
  'With the GetChargingProfilesRequest the CSMS can request profiles with a specific chargingProfilePurpose.',
  'To verify if the CSMS is able to request charging profiles with a specific chargingProfilePurpose on a specific EVSE.',
  (payload, steps) => {
    const criteria = payload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = criteria?.['chargingProfilePurpose'];
    steps.push({
      step: 2,
      description: 'chargingProfile.chargingProfilePurpose must be present',
      status: purpose != null ? 'passed' : 'failed',
      expected: 'chargingProfilePurpose present',
      actual: purpose != null ? `purpose = ${String(purpose)}` : 'omitted',
    });
  },
  () => ({ status: 'Accepted' }),
  { evseId: 1, chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' } },
);

/** TC_K_36_CSMS: Get Charging Profile - EvseId > 0 + chargingProfilePurpose + stackLevel */
export const TC_K_36_CSMS: TestCase = makeGetChargingProfilesTest(
  'TC_K_36_CSMS',
  'Get Charging Profile - EvseId > 0 + chargingProfilePurpose + stackLevel',
  'With the GetChargingProfilesRequest the CSMS can request profiles with specific purpose and stackLevel.',
  'To verify if the CSMS is able to request charging profiles with a specific chargingProfilePurpose AND stackLevel.',
  (payload, steps) => {
    const criteria = payload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = criteria?.['chargingProfilePurpose'];
    const stackLevel = criteria?.['stackLevel'];
    steps.push({
      step: 2,
      description: 'chargingProfilePurpose and stackLevel must be present',
      status: purpose != null && stackLevel != null ? 'passed' : 'failed',
      expected: 'Both present',
      actual: `purpose=${String(purpose)}, stackLevel=${String(stackLevel)}`,
    });
  },
  () => ({ status: 'Accepted' }),
  { evseId: 1, chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 } },
);
