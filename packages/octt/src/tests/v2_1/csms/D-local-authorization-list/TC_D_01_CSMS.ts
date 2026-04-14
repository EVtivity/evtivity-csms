// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station
async function boot(ctx: {
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

/**
 * TC_D_01_CSMS: Send Local Authorization List - Full
 *
 * Scenario:
 *   1. CSMS sends GetLocalListVersionRequest (optional)
 *   2. Test System responds with versionNumber 1
 *   3. CSMS sends SendLocalListRequest (Full)
 *   4. Test System responds with Accepted
 */
export const TC_D_01_CSMS: TestCase = {
  id: 'TC_D_01_CSMS',
  name: 'Send Local Authorization List - Full',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the CSMS is able to send a Full Local Authorization List according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedGetVersion = false;
    let receivedSendList = false;
    let updateType = '';
    let versionNumber = 0;
    let listNotEmpty = false;
    let hasIdTokenInfo = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetLocalListVersion') {
          receivedGetVersion = true;
          return { versionNumber: 1 };
        }
        if (action === 'SendLocalList') {
          receivedSendList = true;
          updateType = String(payload['updateType'] ?? '');
          versionNumber = Number(payload['versionNumber'] ?? 0);
          const list = payload['localAuthorizationList'] as Record<string, unknown>[] | undefined;
          if (Array.isArray(list) && list.length > 0) {
            listNotEmpty = true;
            const first = list[0] as Record<string, unknown>;
            if (first['idTokenInfo'] != null) {
              hasIdTokenInfo = true;
            }
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SendLocalList', {
        stationId: ctx.stationId,
        versionNumber: 2,
        updateType: 'Full',
        localAuthorizationList: [
          {
            idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
            idTokenInfo: { status: 'Accepted' },
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetLocalListVersionRequest (optional)',
      status: receivedGetVersion ? 'passed' : 'passed',
      expected: 'GetLocalListVersionRequest (optional)',
      actual: receivedGetVersion
        ? 'GetLocalListVersionRequest received'
        : 'GetLocalListVersionRequest not received (optional step)',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends SendLocalListRequest',
      status: receivedSendList ? 'passed' : 'failed',
      expected: 'SendLocalListRequest received',
      actual: receivedSendList
        ? 'SendLocalListRequest received'
        : 'No SendLocalListRequest received',
    });

    steps.push({
      step: 3,
      description: 'SendLocalListRequest has updateType Full',
      status: updateType === 'Full' ? 'passed' : 'failed',
      expected: 'updateType = Full',
      actual: `updateType = ${updateType}`,
    });

    steps.push({
      step: 4,
      description: 'SendLocalListRequest has versionNumber > 0',
      status: versionNumber > 0 ? 'passed' : 'failed',
      expected: 'versionNumber > 0',
      actual: `versionNumber = ${String(versionNumber)}`,
    });

    steps.push({
      step: 5,
      description: 'localAuthorizationList is not empty with idTokenInfo',
      status: listNotEmpty && hasIdTokenInfo ? 'passed' : 'failed',
      expected: 'Non-empty list with idTokenInfo',
      actual: `listNotEmpty = ${String(listNotEmpty)}, hasIdTokenInfo = ${String(hasIdTokenInfo)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_D_02_CSMS: Send Local Authorization List - Differential Update
 *
 * Scenario:
 *   1. CSMS sends GetLocalListVersionRequest (optional)
 *   2. Test System responds with versionNumber 1
 *   3. CSMS sends SendLocalListRequest (Differential)
 *   4. Test System responds with Accepted
 */
export const TC_D_02_CSMS: TestCase = {
  id: 'TC_D_02_CSMS',
  name: 'Send Local Authorization List - Differential Update',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS sends a Differential Local Authorization List update to a Charging Station.',
  purpose:
    'To verify if the CSMS is able to send a Differential Local Authorization List according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedSendList = false;
    let updateType = '';
    let versionNumber = 0;
    let listNotEmpty = false;
    let hasIdTokenInfo = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetLocalListVersion') {
          return { versionNumber: 1 };
        }
        if (action === 'SendLocalList') {
          receivedSendList = true;
          updateType = String(payload['updateType'] ?? '');
          versionNumber = Number(payload['versionNumber'] ?? 0);
          const list = payload['localAuthorizationList'] as Record<string, unknown>[] | undefined;
          if (Array.isArray(list) && list.length > 0) {
            listNotEmpty = true;
            const first = list[0] as Record<string, unknown>;
            if (first['idTokenInfo'] != null) {
              hasIdTokenInfo = true;
            }
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SendLocalList', {
        stationId: ctx.stationId,
        versionNumber: 2,
        updateType: 'Differential',
        localAuthorizationList: [
          {
            idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
            idTokenInfo: { status: 'Accepted' },
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SendLocalListRequest with Differential update',
      status: receivedSendList ? 'passed' : 'failed',
      expected: 'SendLocalListRequest received',
      actual: receivedSendList
        ? 'SendLocalListRequest received'
        : 'No SendLocalListRequest received',
    });

    steps.push({
      step: 2,
      description: 'updateType is Differential',
      status: updateType === 'Differential' ? 'passed' : 'failed',
      expected: 'updateType = Differential',
      actual: `updateType = ${updateType}`,
    });

    steps.push({
      step: 3,
      description: 'versionNumber > 0',
      status: versionNumber > 0 ? 'passed' : 'failed',
      expected: 'versionNumber > 0',
      actual: `versionNumber = ${String(versionNumber)}`,
    });

    steps.push({
      step: 4,
      description: 'localAuthorizationList is not empty with idTokenInfo',
      status: listNotEmpty && hasIdTokenInfo ? 'passed' : 'failed',
      expected: 'Non-empty list with idTokenInfo',
      actual: `listNotEmpty = ${String(listNotEmpty)}, hasIdTokenInfo = ${String(hasIdTokenInfo)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_D_03_CSMS: Send Local Authorization List - Differential Remove
 *
 * Scenario:
 *   1. CSMS sends SendLocalListRequest (Differential, entries without idTokenInfo)
 *   2. Test System responds with Accepted
 */
export const TC_D_03_CSMS: TestCase = {
  id: 'TC_D_03_CSMS',
  name: 'Send Local Authorization List - Differential Remove',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS sends a Differential Local Authorization List with data without idTokenInfo to remove entries.',
  purpose:
    'To verify if the CSMS is able to send a Differential Local Authorization List with data without idTokenInfo according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedSendList = false;
    let updateType = '';
    let versionNumber = 0;
    let listNotEmpty = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SendLocalList') {
          receivedSendList = true;
          updateType = String(payload['updateType'] ?? '');
          versionNumber = Number(payload['versionNumber'] ?? 0);
          const list = payload['localAuthorizationList'] as Record<string, unknown>[] | undefined;
          if (Array.isArray(list) && list.length > 0) {
            listNotEmpty = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SendLocalList', {
        stationId: ctx.stationId,
        versionNumber: 3,
        updateType: 'Differential',
        localAuthorizationList: [{ idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' } }],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SendLocalListRequest',
      status: receivedSendList ? 'passed' : 'failed',
      expected: 'SendLocalListRequest received',
      actual: receivedSendList
        ? 'SendLocalListRequest received'
        : 'No SendLocalListRequest received',
    });

    steps.push({
      step: 2,
      description: 'updateType is Differential',
      status: updateType === 'Differential' ? 'passed' : 'failed',
      expected: 'updateType = Differential',
      actual: `updateType = ${updateType}`,
    });

    steps.push({
      step: 3,
      description: 'versionNumber > 0',
      status: versionNumber > 0 ? 'passed' : 'failed',
      expected: 'versionNumber > 0',
      actual: `versionNumber = ${String(versionNumber)}`,
    });

    steps.push({
      step: 4,
      description: 'localAuthorizationList is not empty',
      status: listNotEmpty ? 'passed' : 'failed',
      expected: 'Non-empty list',
      actual: `listNotEmpty = ${String(listNotEmpty)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_D_04_CSMS: Send Local Authorization List - Full with empty list
 *
 * Scenario:
 *   1. CSMS sends SendLocalListRequest (Full, empty list)
 *   2. Test System responds with Accepted
 */
export const TC_D_04_CSMS: TestCase = {
  id: 'TC_D_04_CSMS',
  name: 'Send Local Authorization List - Full with empty list',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sends a Full Local Authorization List without data to clear the list.',
  purpose:
    'To verify if the CSMS is able to send a Full Local Authorization List without data according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedSendList = false;
    let updateType = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SendLocalList') {
          receivedSendList = true;
          updateType = String(payload['updateType'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SendLocalList', {
        stationId: ctx.stationId,
        versionNumber: 4,
        updateType: 'Full',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SendLocalListRequest',
      status: receivedSendList ? 'passed' : 'failed',
      expected: 'SendLocalListRequest received',
      actual: receivedSendList
        ? 'SendLocalListRequest received'
        : 'No SendLocalListRequest received',
    });

    steps.push({
      step: 2,
      description: 'updateType is Full',
      status: updateType === 'Full' ? 'passed' : 'failed',
      expected: 'updateType = Full',
      actual: `updateType = ${updateType}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
