// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_073_CS: CsTestCase = {
  id: 'TC_073_CS',
  name: 'Update Charge Point Password for HTTP Basic Authentication',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System configures a new password for HTTP Basic Authentication.',
  purpose: 'To check if the Charge Point is able to switch to a new Basic Authentication password.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    const resp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'AuthorizationKey',
      value: '4F43415F4F4354545F61646D696E5F74657374',
    });
    steps.push({
      step: 2,
      description: 'ChangeConfiguration AuthorizationKey Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_074_CS: CsTestCase = {
  id: 'TC_074_CS',
  name: 'Update Charge Point Certificate by request of Central System',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The CS requests the Charge Point to renew its certificate.',
  purpose:
    'To test if the Charge Point renews its ChargePointCertificate when the Central System requests it.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_075_1_CS: CsTestCase = {
  id: 'TC_075_1_CS',
  name: 'Install certificate - ManufacturerRootCertificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System requests the Charge Point to install a new manufacturer root certificate.',
  purpose: 'To check if the Charge Point is able to install a certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_075_2_CS: CsTestCase = {
  id: 'TC_075_2_CS',
  name: 'Install certificate - CentralSystemRootCertificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System requests the Charge Point to install a new Central System root certificate.',
  purpose: 'To check if the Charge Point is able to install a certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_076_CS: CsTestCase = {
  id: 'TC_076_CS',
  name: 'Delete a specific certificate from the Charge Point',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'Delete an installed certificate from the Charge Point.',
  purpose: 'To check if the Charge Point is able to delete an installed certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_077_CS: CsTestCase = {
  id: 'TC_077_CS',
  name: 'Invalid ChargePointCertificate Security Event',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point notifies the Central System of an invalid certificate.',
  purpose: 'To check if the Charge Point registers a security event for invalid certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_078_CS: CsTestCase = {
  id: 'TC_078_CS',
  name: 'Invalid CentralSystemCertificate Security Event',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point notifies the Central System of an invalid certificate.',
  purpose: 'To check if the Charge Point registers a security event for invalid CS certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_079_CS: CsTestCase = {
  id: 'TC_079_CS',
  name: 'Get Security Log',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point uploads a security log to a specified location.',
  purpose: 'To check whether the Charge Point can upload its security log.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_080_CS: CsTestCase = {
  id: 'TC_080_CS',
  name: 'Secure Firmware Update',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The firmware of a Charge Point is updated in a secure way.',
  purpose: 'To check whether the Charge Point can update its firmware in a secure way.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_081_CS: CsTestCase = {
  id: 'TC_081_CS',
  name: 'Secure Firmware Update - Invalid Signature',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point validates the Signature and deems it invalid.',
  purpose: 'To check whether the Charge Point validates the signature.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
