// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_045_1_CS: CsTestCase = {
  id: 'TC_045_1_CS',
  name: 'Get Diagnostics',
  module: '20-diagnostics',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point uploads a diagnostics log to a specified location.',
  purpose: 'Check whether the Charge Point can upload its diagnostics.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'DiagnosticsStatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    await ctx.server.sendCommand('GetDiagnostics', { location: 'ftp://example.com/diagnostics/' });
    const ds1 = await ctx.server.waitForMessage('DiagnosticsStatusNotification', 60_000);
    steps.push({
      step: 3,
      description: 'DiagnosticsStatusNotification Uploading',
      status: (ds1['status'] as string) === 'Uploading' ? 'passed' : 'failed',
      expected: 'status = Uploading',
      actual: `status = ${String(ds1['status'])}`,
    });
    const ds2 = await ctx.server.waitForMessage('DiagnosticsStatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'DiagnosticsStatusNotification Uploaded',
      status: (ds2['status'] as string) === 'Uploaded' ? 'passed' : 'failed',
      expected: 'status = Uploaded',
      actual: `status = ${String(ds2['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_045_2_CS: CsTestCase = {
  id: 'TC_045_2_CS',
  name: 'Get Diagnostics - Upload Failed',
  module: '20-diagnostics',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'When getting the diagnostics, the upload of the log fails.',
  purpose: 'Check whether the Charge Point reports UploadFailed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'DiagnosticsStatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    await ctx.server.sendCommand('GetDiagnostics', {
      location: 'ftp://127.0.0.1:21/files/failedLocation',
      retries: 0,
    });
    // Uploading (optional)
    try {
      await ctx.server.waitForMessage('DiagnosticsStatusNotification', 30_000);
    } catch {
      /* optional */
    }
    const ds = await ctx.server.waitForMessage('DiagnosticsStatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'DiagnosticsStatusNotification UploadFailed',
      status: (ds['status'] as string) === 'UploadFailed' ? 'passed' : 'failed',
      expected: 'status = UploadFailed',
      actual: `status = ${String(ds['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
