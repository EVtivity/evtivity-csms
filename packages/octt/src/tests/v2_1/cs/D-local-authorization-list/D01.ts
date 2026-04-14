// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_D_01_CS: Send Local Authorization List - Full
 * CSMS sends a full local authorization list to the station and verifies acceptance and version.
 */
export const TC_D_01_CS: CsTestCase = {
  id: 'TC_D_01_CS',
  name: 'Send Local Authorization List - Full',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to replace the Local Authorization List according to the mechanism described in the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const versionNumber = 2;
    const idToken = 'OCTT-TOKEN-001';
    const idTokenType = 'ISO14443';

    // Step 1-2: Send SendLocalListRequest (Full) and validate response
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber,
      updateType: 'Full',
      localAuthorizationList: [
        {
          idToken: { idToken, type: idTokenType },
          idTokenInfo: { status: 'Accepted' },
        },
      ],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be Accepted',
      status: sendStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description: 'GetLocalListVersionResponse - versionNumber must equal version sent in step 1',
      status: returnedVersion === versionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(versionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_02_CS: Send Local Authorization List - Differential Update
 * CSMS sends a differential update to add a new token and verifies acceptance and version.
 */
export const TC_D_02_CS: CsTestCase = {
  id: 'TC_D_02_CS',
  name: 'Send Local Authorization List - Differential Update',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to replace the Local Authorization List in differential type according to the mechanism described in the specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const versionNumber = 3;
    const idToken2 = 'OCTT-TOKEN-002';
    const idTokenType2 = 'ISO14443';

    // Step 1-2: Send SendLocalListRequest (Differential) and validate response
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber,
      updateType: 'Differential',
      localAuthorizationList: [
        {
          idToken: { idToken: idToken2, type: idTokenType2 },
          idTokenInfo: { status: 'Accepted' },
        },
      ],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be Accepted',
      status: sendStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description: 'GetLocalListVersionResponse - versionNumber must equal version sent in step 1',
      status: returnedVersion === versionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(versionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_03_CS: Send Local Authorization List - Differential Remove
 * CSMS sends a differential update with entries lacking idTokenInfo to remove them.
 */
export const TC_D_03_CS: CsTestCase = {
  id: 'TC_D_03_CS',
  name: 'Send Local Authorization List - Differential Remove',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to remove items from the Local Authorization List when sent in differential type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const versionNumber = 3;

    // Step 1-2: Send SendLocalListRequest (Differential) with entries that have no idTokenInfo (remove)
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber,
      updateType: 'Differential',
      localAuthorizationList: [
        {
          idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        },
      ],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be Accepted',
      status: sendStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description: 'GetLocalListVersionResponse - versionNumber must equal version sent in step 1',
      status: returnedVersion === versionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(versionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_04_CS: Send Local Authorization List - Full with empty list
 * CSMS sends a full update with an empty list to clear all entries.
 */
export const TC_D_04_CS: CsTestCase = {
  id: 'TC_D_04_CS',
  name: 'Send Local Authorization List - Full with empty list',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to remove all items from the Local Authorization List when sent in full type with an empty list.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const versionNumber = 2;

    // Step 1-2: Send SendLocalListRequest (Full) with empty list
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber,
      updateType: 'Full',
      localAuthorizationList: [],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be Accepted',
      status: sendStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description:
        'GetLocalListVersionResponse - versionNumber must equal configured versionNumber',
      status: returnedVersion === versionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(versionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_05_CS: Send Local Authorization List - Differential with empty list
 * CSMS sends a differential update with an empty list and verifies version is updated.
 */
export const TC_D_05_CS: CsTestCase = {
  id: 'TC_D_05_CS',
  name: 'Send Local Authorization List - Differential with empty list',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to correctly respond on a Local Authorization List when sent in differential type with an empty list.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const versionNumber = 3;

    // Step 1-2: Send SendLocalListRequest (Differential) with empty list
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber,
      updateType: 'Differential',
      localAuthorizationList: [],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be Accepted',
      status: sendStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description: 'GetLocalListVersionResponse - versionNumber must equal version sent in step 1',
      status: returnedVersion === versionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(versionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_06_CS: Send Local Authorization List - VersionMismatch
 * CSMS sends a differential update with a lower version number and verifies VersionMismatch response.
 */
export const TC_D_06_CS: CsTestCase = {
  id: 'TC_D_06_CS',
  name: 'Send Local Authorization List - VersionMismatch',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to correctly respond on a Local Authorization List when sent in differential type with a version mismatch.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const configuredVersionNumber = 3;
    const sentVersionNumber = configuredVersionNumber - 1;

    // Setup: Send a Full list at version 3 to establish current version
    const setupRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber: configuredVersionNumber,
      updateType: 'Full',
      localAuthorizationList: [
        {
          idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
          idTokenInfo: { status: 'Accepted' },
        },
      ],
    });
    if ((setupRes['status'] as string) !== 'Accepted') {
      steps.push({
        step: 0,
        description: 'Setup: SendLocalList Full to establish version',
        status: 'failed',
        expected: 'status = Accepted',
        actual: `status = ${setupRes['status']}`,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 1-2: Send SendLocalListRequest (Differential) with lower version
    const sendRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber: sentVersionNumber,
      updateType: 'Differential',
      localAuthorizationList: [
        {
          idToken: { idToken: 'OCTT-TOKEN-002', type: 'ISO14443' },
          idTokenInfo: { status: 'Accepted' },
        },
      ],
    });
    const sendStatus = sendRes['status'] as string;
    steps.push({
      step: 2,
      description: 'SendLocalListResponse - status must be VersionMismatch',
      status: sendStatus === 'VersionMismatch' ? 'passed' : 'failed',
      expected: 'status = VersionMismatch',
      actual: `status = ${sendStatus}`,
    });

    // Step 3-4: Send GetLocalListVersionRequest and validate version unchanged
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 4,
      description:
        'GetLocalListVersionResponse - versionNumber must equal configured versionNumber (unchanged)',
      status: returnedVersion === configuredVersionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(configuredVersionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_D_07_CS: Send Local Authorization List - Persistent over reboot
 * Verifies the station persists the local authorization list version across reboots.
 */
export const TC_D_07_CS: CsTestCase = {
  id: 'TC_D_07_CS',
  name: 'Send Local Authorization List - Persistent over reboot',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a Local Authorization List which a Charging Station can use for the authorization of idTokens.',
  purpose:
    'To verify if the Charging Station is able to save the Local Authorization List persistent over reboot.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const configuredVersionNumber = 2;

    // Setup: Send a Full list to establish a known version
    const setupRes = await ctx.server.sendCommand('SendLocalList', {
      versionNumber: configuredVersionNumber,
      updateType: 'Full',
      localAuthorizationList: [
        {
          idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
          idTokenInfo: { status: 'Accepted' },
        },
      ],
    });
    if ((setupRes['status'] as string) !== 'Accepted') {
      steps.push({
        step: 0,
        description: 'Setup: SendLocalList Full to establish version',
        status: 'failed',
        expected: 'status = Accepted',
        actual: `status = ${setupRes['status']}`,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 1: Trigger a reboot
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      return {};
    });
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'OnIdle' });
    if ((resetRes['status'] as string) !== 'Accepted') {
      steps.push({
        step: 0,
        description: 'Setup: Reset station',
        status: 'failed',
        expected: 'status = Accepted',
        actual: `status = ${resetRes['status']}`,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // Wait for reboot (BootNotification)
    try {
      await ctx.server.waitForMessage('BootNotification', 15000);
    } catch {
      // May already be consumed
    }
    // Wait for StatusNotification after reboot
    try {
      await ctx.server.waitForMessage('StatusNotification', 10000);
    } catch {
      // May already be consumed
    }

    // Step 2: Send GetLocalListVersionRequest and validate version persisted
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 2,
      description:
        'GetLocalListVersionResponse - versionNumber must equal configured versionNumber',
      status: returnedVersion === configuredVersionNumber ? 'passed' : 'failed',
      expected: `versionNumber = ${String(configuredVersionNumber)}`,
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
