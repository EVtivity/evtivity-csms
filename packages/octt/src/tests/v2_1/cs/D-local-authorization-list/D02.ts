// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_D_08_CS: Get Local List Version - Success
 * CSMS requests the local list version and verifies the station returns the configured version.
 */
export const TC_D_08_CS: CsTestCase = {
  id: 'TC_D_08_CS',
  name: 'Get Local List Version - Success',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station for the version number of the Local Authorization List by sending a GetLocalListVersionRequest.',
  purpose:
    'To verify if the Charging Station is able to respond the Local Authorization List version number according to the mechanism described in the specification.',
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

    // Step 1-2: Send GetLocalListVersionRequest and validate version
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

/**
 * TC_D_10_CS: Get Local List Version - Function disabled
 * CSMS requests the local list version when LocalAuthListEnabled is false.
 * Station must respond with versionNumber 0.
 */
export const TC_D_10_CS: CsTestCase = {
  id: 'TC_D_10_CS',
  name: 'Get Local List Version - Function disabled',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station for the version number of the Local Authorization List by sending a GetLocalListVersionRequest.',
  purpose:
    'To verify if the Charging Station is able to respond the Local Authorization List version number according to the mechanism when the function is disabled.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1-2: Send GetLocalListVersionRequest, expect version 0 when disabled
    const getRes = await ctx.server.sendCommand('GetLocalListVersion', {});
    const returnedVersion = getRes['versionNumber'] as number;
    steps.push({
      step: 2,
      description: 'GetLocalListVersionResponse - versionNumber must be 0',
      status: returnedVersion === 0 ? 'passed' : 'failed',
      expected: 'versionNumber = 0',
      actual: `versionNumber = ${String(returnedVersion)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
