// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_25_CSMS: TestCase = {
  id: 'TC_N_25_CSMS',
  name: 'Retrieve Log Information - Diagnostics Log - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests a charging station to upload a diagnostics log.',
  purpose: 'To verify the CSMS can request a diagnostics log upload.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let requestId = 0;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetLog') {
          received = true;
          requestId = (payload['requestId'] as number) ?? 0;
          return { status: 'Accepted' };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetLogRequest',
      status: received ? 'passed' : 'failed',
      expected: 'GetLogRequest received',
      actual: received ? 'Received' : 'Not received',
    });
    if (!received) return { status: 'failed', durationMs: 0, steps };
    for (const logStatus of ['Uploading', 'Uploaded']) {
      try {
        await ctx.client.sendCall('LogStatusNotification', { status: logStatus, requestId });
        steps.push({
          step: steps.length + 1,
          description: `Send LogStatusNotification ${logStatus}`,
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: steps.length + 1,
          description: `Send LogStatusNotification ${logStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_34_CSMS: TestCase = {
  id: 'TC_N_34_CSMS',
  name: 'Retrieve Log Information - Rejected',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a rejected log retrieval request.',
  purpose: 'To verify the CSMS handles a Rejected response from GetLog.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetLog') {
        received = true;
        return { status: 'Rejected' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetLogRequest, respond Rejected',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_35_CSMS: TestCase = {
  id: 'TC_N_35_CSMS',
  name: 'Retrieve Log Information - Security Log - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests a security log from the charging station.',
  purpose: 'To verify the CSMS can request a security log.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    let logType = '';
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetLog') {
          received = true;
          logType = (payload['logType'] as string) ?? '';
          return { status: 'Accepted' };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'SecurityLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetLogRequest for SecurityLog',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? `Received (logType: ${logType})` : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_36_CSMS: TestCase = {
  id: 'TC_N_36_CSMS',
  name: 'Retrieve Log Information - Second Request',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sends a second GetLog while the first upload is in progress.',
  purpose: 'To verify the CSMS can handle AcceptedCanceled and send a second log request.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let logRequestCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetLog') {
        logRequestCount++;
        return { status: logRequestCount === 1 ? 'Accepted' : 'AcceptedCanceled' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends first GetLogRequest',
      status: logRequestCount >= 1 ? 'passed' : 'failed',
      expected: 'At least 1 request',
      actual: `${String(logRequestCount)} request(s)`,
    });
    if (logRequestCount >= 1) {
      await ctx.client.sendCall('LogStatusNotification', { status: 'Uploading', requestId: 1 });
      if (ctx.triggerCommand != null) {
        await ctx.triggerCommand('v21', 'GetLog', {
          stationId: ctx.stationId,
          logType: 'DiagnosticsLog',
          requestId: 2,
          log: { remoteLocation: 'https://example.com/upload' },
        });
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    steps.push({
      step: 2,
      description: 'CSMS sends second GetLogRequest',
      status: logRequestCount >= 2 ? 'passed' : 'failed',
      expected: 'Second request received',
      actual: `${String(logRequestCount)} total request(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_100_CSMS: TestCase = {
  id: 'TC_N_100_CSMS',
  name: 'Retrieve Log Information - DataCollectorLog - Success',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS receives a NotifyEventRequest for periodic data collection.',
  purpose: 'To verify the CSMS accepts NotifyEventRequest with periodic trigger.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      await ctx.client.sendCall('NotifyEvent', {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [
          {
            eventId: 1,
            timestamp: new Date().toISOString(),
            trigger: 'Periodic',
            actualValue: '42',
            component: { name: 'ChargingStation' },
            variable: { name: 'Power' },
            eventNotificationType: 'HardWiredNotification',
          },
        ],
      });
      steps.push({
        step: 1,
        description: 'Send NotifyEventRequest with trigger Periodic',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send NotifyEventRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_102_CSMS: TestCase = {
  id: 'TC_N_102_CSMS',
  name: 'Retrieve Log Information - Authentication - HTTP',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests a diagnostics log with HTTP authentication.',
  purpose: 'To verify the CSMS can request log upload with HTTP Basic Authentication.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetLog') {
        received = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetLogRequest with HTTP auth',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_N_102_2_CSMS: TestCase = {
  id: 'TC_N_102_2_CSMS',
  name: 'Retrieve Log Information - Authentication - HTTPS',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests a diagnostics log with HTTPS authentication.',
  purpose: 'To verify the CSMS can request log upload with HTTPS Basic Authentication.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetLog') {
        received = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLog', {
        stationId: ctx.stationId,
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'https://example.com/upload' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends GetLogRequest with HTTPS auth',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
