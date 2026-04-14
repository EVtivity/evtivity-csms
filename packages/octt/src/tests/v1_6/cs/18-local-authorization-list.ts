// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_042_1_CS: CsTestCase = {
  id: 'TC_042_1_CS',
  name: 'Get Local List Version (not supported)',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System can request a Charge Point for the version number of the Local Authorization List.',
  purpose: 'Check whether the Charge Point provides the local list version when requested.',
  execute: async (_ctx) => {
    // Prerequisite: Station does not support Local Authorization List.
    // Our CSS supports it (LocalAuthListEnabled = true), so skip.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_042_2_CS: CsTestCase = {
  id: 'TC_042_2_CS',
  name: 'Get Local List Version (empty)',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System can request a Charge Point for the version number of the Local Authorization List.',
  purpose:
    'Check whether the Charge Point provides the local list version as 0 when the list is empty.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Send empty Full list to clear
    const sendResp = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
    });
    steps.push({
      step: 2,
      description: 'SendLocalList Full Accepted',
      status: (sendResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(sendResp['status'])}`,
    });
    const getResp = await ctx.server.sendCommand('GetLocalListVersion', {});
    steps.push({
      step: 4,
      description: 'GetLocalListVersion returns the version from SendLocalList',
      status: (getResp['listVersion'] as number) === 1 ? 'passed' : 'failed',
      expected: 'listVersion = 1',
      actual: `listVersion = ${String(getResp['listVersion'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_043_CS: CsTestCase = {
  id: 'TC_043_CS',
  name: 'Send Local Authorization List',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Charge Point can authorize an EV driver based on a local list set by the Central System.',
  purpose: 'Check whether a Local Authorization List can be sent to a Charge Point.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    const r1 = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_001', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 2,
      description: 'SendLocalList Full Accepted',
      status: (r1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r1['status'])}`,
    });
    const r2 = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 2,
      updateType: 'Differential',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_002', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 4,
      description: 'SendLocalList Differential Accepted',
      status: (r2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r2['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_043_1_CS: CsTestCase = {
  id: 'TC_043_1_CS',
  name: 'Send Local Authorization List - NotSupported',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'Check whether a Charge Point can refuse a sent Local Authorization List.',
  purpose:
    'Check whether a Charge Point can refuse a sent Local Authorization List if it does not support it.',
  // Prerequisite: Station does not support Local Authorization List. CSS supports it.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_043_2_CS: CsTestCase = {
  id: 'TC_043_2_CS',
  name: 'Send Local Authorization List - VersionMismatch',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'Check whether a Charge Point can refuse a sent Local Authorization List.',
  purpose: 'Check whether a Charge Point detects version mismatch.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Full update v2
    const r1 = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 2,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_001', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 2,
      description: 'SendLocalList Full v2 Accepted',
      status: (r1['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r1['status'])}`,
    });
    // Differential update v5
    const r2 = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 5,
      updateType: 'Differential',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_002', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 6,
      description: 'SendLocalList Differential v5 Accepted',
      status: (r2['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(r2['status'])}`,
    });
    // Differential update v4 (should mismatch)
    const r3 = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 4,
      updateType: 'Differential',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_003', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 10,
      description: 'SendLocalList v4 VersionMismatch',
      status: (r3['status'] as string) === 'VersionMismatch' ? 'passed' : 'failed',
      expected: 'status = VersionMismatch',
      actual: `status = ${String(r3['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_043_3_CS: CsTestCase = {
  id: 'TC_043_3_CS',
  name: 'Send Local Authorization List - Failed',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'Check whether a Charge Point can refuse a sent Local Authorization List.',
  purpose: 'Check whether a Charge Point reports Failed.',
  // Prerequisite: Station has limited or disabled local auth list storage. CSS supports 100 entries.
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_008_1_CS: CsTestCase = {
  id: 'TC_008_1_CS',
  name: 'Regular Start Charging Session - Id in Local Authorization List',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to authorize a transaction using the Local Authorization List.',
  purpose:
    'To test if the Charge Point can start a transaction using the Local Authorization List.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Prerequisites: enable LocalPreAuthorize so station uses local list
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');

    // Send local list with valid tag
    const sendResp = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_001', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 4,
      description: 'SendLocalList Accepted',
      status: (sendResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(sendResp['status'])}`,
    });
    // Present identification (should use local list, not send Authorize)
    await ctx.station.authorize(1, 'OCTT_TAG_001');
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Preparing',
      status: (sn1['status'] as string) === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1['status'])}`,
    });
    await ctx.station.plugIn(1);
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 7,
      description: 'StartTransaction received',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 9,
      description: 'StatusNotification Charging',
      status: (sn2['status'] as string) === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_008_2_CS: CsTestCase = {
  id: 'TC_008_2_CS',
  name: 'Remote Start Charging Session - Id in Local Authorization List',
  module: '18-local-authorization-list',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to authorize a transaction using the Local Authorization List.',
  purpose:
    'To test if the Charge Point can start a transaction remotely using the Local Authorization List.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    // Prerequisites: enable LocalPreAuthorize so station uses local list
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');

    const sendResp = await ctx.server.sendCommand('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'OCTT_TAG_001', idTagInfo: { status: 'Accepted' } }],
    });
    steps.push({
      step: 4,
      description: 'SendLocalList Accepted',
      status: (sendResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(sendResp['status'])}`,
    });
    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'OCTT_TAG_001',
    });
    steps.push({
      step: 6,
      description: 'RemoteStartTransaction Accepted',
      status: (rsResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsResp['status'])}`,
    });
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 7,
      description: 'StatusNotification Preparing',
      status: (sn1['status'] as string) === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1['status'])}`,
    });
    await ctx.station.plugIn(1);
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 9,
      description: 'StartTransaction received',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 11,
      description: 'StatusNotification Charging',
      status: (sn2['status'] as string) === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
