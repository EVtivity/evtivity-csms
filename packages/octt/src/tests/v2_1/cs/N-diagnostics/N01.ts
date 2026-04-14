// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_N_25_CS: CsTestCase = {
  id: 'TC_N_25_CS',
  name: 'Retrieve Log Information - Diagnostics Log - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests diagnostics log information from the Charging Station.',
  purpose: 'To verify if the Charging Station is able to successfully upload a diagnostics log.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const requestId = 1;
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    const status = res['status'] as string;
    const filename = res['filename'] as string | undefined;
    steps.push({
      step: 1,
      description: 'GetLogResponse status Accepted, filename not empty',
      status: status === 'Accepted' && filename != null && filename !== '' ? 'passed' : 'failed',
      expected: 'status = Accepted, filename present',
      actual: `status = ${status}, filename = ${filename}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      const logStatus = msg['status'] as string;
      const reqId = msg['requestId'] as number;
      steps.push({
        step: 2,
        description: 'LogStatusNotification status Uploading',
        status: logStatus === 'Uploading' && reqId === requestId ? 'passed' : 'failed',
        expected: 'status = Uploading, requestId matches',
        actual: `status = ${logStatus}, requestId = ${reqId}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: 'failed',
        expected: 'status = Uploading',
        actual: 'Timeout',
      });
    }

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 300000);
      const logStatus = msg['status'] as string;
      const reqId = msg['requestId'] as number;
      steps.push({
        step: 3,
        description: 'LogStatusNotification status Uploaded',
        status: logStatus === 'Uploaded' && reqId === requestId ? 'passed' : 'failed',
        expected: 'status = Uploaded, requestId matches',
        actual: `status = ${logStatus}, requestId = ${reqId}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: 'failed',
        expected: 'status = Uploaded',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_26_CS: CsTestCase = {
  id: 'TC_N_26_CS',
  name: 'Retrieve Log Information - Diagnostics Log - Upload failed',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests diagnostics log upload to a non-existent path.',
  purpose: 'To verify if the Charging Station correctly reports upload failure.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 2,
      retries: 3,
      retryInterval: 5,
      log: { remoteLocation: 'https://logs.example.com/nonexistent' },
    });
    steps.push({
      step: 1,
      description: 'GetLogResponse status Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      const s = msg['status'] as string;
      const validFailure = [
        'UploadFailure',
        'BadMessage',
        'PermissionDenied',
        'NotSupportedOperation',
      ].includes(s);
      steps.push({
        step: 2,
        description: 'LogStatusNotification with failure status',
        status: validFailure ? 'passed' : 'failed',
        expected: 'status = UploadFailure/BadMessage/PermissionDenied/NotSupportedOperation',
        actual: `status = ${s}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification failure',
        status: 'failed',
        expected: 'Failure status',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_34_CS: CsTestCase = {
  id: 'TC_N_34_CS',
  name: 'Retrieve Log Information - Rejected',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests log information when none is available.',
  purpose:
    'To verify if the Charging Station rejects the request when no information is available.',
  execute: async (_ctx) => {
    // CSS always has simulated log data available. Cannot test the Rejected case.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_35_CS: CsTestCase = {
  id: 'TC_N_35_CS',
  name: 'Retrieve Log Information - Security Log - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests security log information from the Charging Station.',
  purpose: 'To verify if the Charging Station is able to successfully upload a security log.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const requestId = 4;
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'SecurityLog',
      requestId,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    steps.push({
      step: 1,
      description: 'GetLogResponse status Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: (msg['status'] as string) === 'Uploading' ? 'passed' : 'failed',
        expected: 'status = Uploading',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: 'failed',
        expected: 'status = Uploading',
        actual: 'Timeout',
      });
    }

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 300000);
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: (msg['status'] as string) === 'Uploaded' ? 'passed' : 'failed',
        expected: 'status = Uploaded',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: 'failed',
        expected: 'status = Uploaded',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_36_CS: CsTestCase = {
  id: 'TC_N_36_CS',
  name: 'Retrieve Log Information - Second Request',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a second GetLog request to cancel the first.',
  purpose: 'To verify if the Charging Station cancels the first upload on a second request.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res1 = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 5,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    steps.push({
      step: 1,
      description: 'First GetLogResponse Accepted',
      status: (res1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res1['status']}`,
    });

    try {
      await ctx.server.waitForMessage('LogStatusNotification', 60000);
    } catch {
      /* optional */
    }

    const res2 = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 6,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    steps.push({
      step: 2,
      description: 'Second GetLogResponse AcceptedCanceled',
      status: (res2['status'] as string) === 'AcceptedCanceled' ? 'passed' : 'failed',
      expected: 'status = AcceptedCanceled',
      actual: `status = ${res2['status']}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_100_CS: CsTestCase = {
  id: 'TC_N_100_CS',
  name: 'Retrieve Log Information - DataCollectorLog - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a DataCollectorLog from the Charging Station.',
  purpose: 'To verify if the Charging Station uploads a DataCollectorLog as specified.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const requestId = 7;
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DataCollectorLog',
      requestId,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    const filename = res['filename'] as string | undefined;
    steps.push({
      step: 1,
      description: 'GetLogResponse Accepted with filename',
      status: (res['status'] as string) === 'Accepted' && filename != null ? 'passed' : 'failed',
      expected: 'status = Accepted, filename present',
      actual: `status = ${res['status']}, filename = ${filename}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: (msg['status'] as string) === 'Uploading' ? 'passed' : 'failed',
        expected: 'status = Uploading',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: 'failed',
        expected: 'status = Uploading',
        actual: 'Timeout',
      });
    }

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 300000);
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: (msg['status'] as string) === 'Uploaded' ? 'passed' : 'failed',
        expected: 'status = Uploaded',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: 'failed',
        expected: 'status = Uploaded',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_101_CS: CsTestCase = {
  id: 'TC_N_101_CS',
  name: 'Retrieve Log Information - validations (redirect failure)',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests log upload to a redirecting location.',
  purpose: 'To verify if the Charging Station fails to upload a log to a redirected location.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 8,
      log: { remoteLocation: 'https://logs.example.com/redirect' },
    });
    steps.push({
      step: 1,
      description: 'GetLogResponse Accepted',
      status: (res['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${res['status']}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      steps.push({
        step: 2,
        description: 'LogStatusNotification UploadFailure',
        status: (msg['status'] as string) === 'UploadFailure' ? 'passed' : 'failed',
        expected: 'status = UploadFailure',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification UploadFailure',
        status: 'failed',
        expected: 'status = UploadFailure',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_102_CS: CsTestCase = {
  id: 'TC_N_102_CS',
  name: 'Retrieve Log Information - Authentication - HTTP',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests log upload with HTTP authentication in the URL.',
  purpose: 'To verify if the Charging Station uploads a log using HTTP authentication.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const requestId = 9;
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId,
      log: { remoteLocation: 'http://user:pass@logs.example.com/upload' },
    });
    const filename = res['filename'] as string | undefined;
    steps.push({
      step: 1,
      description: 'GetLogResponse Accepted, filename not empty',
      status:
        (res['status'] as string) === 'Accepted' && filename != null && filename !== ''
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, filename present',
      actual: `status = ${res['status']}, filename = ${filename}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: (msg['status'] as string) === 'Uploading' ? 'passed' : 'failed',
        expected: 'status = Uploading',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: 'failed',
        expected: 'status = Uploading',
        actual: 'Timeout',
      });
    }

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 300000);
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: (msg['status'] as string) === 'Uploaded' ? 'passed' : 'failed',
        expected: 'status = Uploaded',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: 'failed',
        expected: 'status = Uploaded',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_103_CS: CsTestCase = {
  id: 'TC_N_103_CS',
  name: 'Retrieve Log Information - Authentication - HTTPS',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests log upload with HTTPS authentication in the URL.',
  purpose: 'To verify if the Charging Station uploads a log using HTTPS authentication.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const requestId = 10;
    const res = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId,
      log: { remoteLocation: 'https://user:pass@logs.example.com/upload' },
    });
    const filename = res['filename'] as string | undefined;
    steps.push({
      step: 1,
      description: 'GetLogResponse Accepted, filename not empty',
      status:
        (res['status'] as string) === 'Accepted' && filename != null && filename !== ''
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, filename present',
      actual: `status = ${res['status']}, filename = ${filename}`,
    });

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 120000);
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: (msg['status'] as string) === 'Uploading' ? 'passed' : 'failed',
        expected: 'status = Uploading',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'LogStatusNotification Uploading',
        status: 'failed',
        expected: 'status = Uploading',
        actual: 'Timeout',
      });
    }

    try {
      const msg = await ctx.server.waitForMessage('LogStatusNotification', 300000);
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: (msg['status'] as string) === 'Uploaded' ? 'passed' : 'failed',
        expected: 'status = Uploaded',
        actual: `status = ${msg['status']}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'LogStatusNotification Uploaded',
        status: 'failed',
        expected: 'status = Uploaded',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
