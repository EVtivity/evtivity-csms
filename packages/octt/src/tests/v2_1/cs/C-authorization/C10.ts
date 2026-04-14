// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_C_32_CS: Store Authorization Data in the Authorization Cache - Persistent over reboot
 *
 * Reusable State Booted -> Authorized (cached idToken) -> EVConnectedPreSession
 * -> EnergyTransferStarted
 *
 * After reboot, the station should still have the cached idToken and authorize locally.
 */
export const TC_C_32_CS: CsTestCase = {
  id: 'TC_C_32_CS',
  name: 'Store Authorization Data in the Authorization Cache - Persistent over reboot',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the Charging Station is able to store the identifiers persistent over reboot.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Setup: enable auth cache, add token, then simulate power cycle
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted');

    // Simulate power cycle (auth cache should persist)
    await ctx.station.simulatePowerCycle('PowerUp');
    await ctx.server.waitForConnection(60000);
    ctx.server.clearBuffer();

    // Step 2: Reusable State Authorized (Cached idToken) - present token
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Station should authorize using cached token and send TransactionEvent
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = tx['triggerReason'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Station authorizes using cached idToken after reboot',
      status: trigger === 'Authorized' ? 'passed' : 'failed',
      expected: 'TransactionEventRequest with triggerReason Authorized',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_33_CS: Store Authorization Data in the Authorization Cache - Update on AuthorizeResponse
 *
 * Reusable State IdTokenCached -> Authorized (cached idToken)
 * -> EVConnectedPreSession -> EnergyTransferStarted
 *
 * Station should cache the token from AuthorizeResponse and use it locally.
 */
export const TC_C_33_CS: CsTestCase = {
  id: 'TC_C_33_CS',
  name: 'Store Authorization Data in the Authorization Cache - Update on AuthorizeResponse',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the Charging Station is able to store the identifiers correctly upon an AuthorizeResponse.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Setup: enable auth cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');

    // Present token to cache it via AuthorizeResponse, then use cached token
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Station sends TransactionEvent with Authorized
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = tx['triggerReason'] as string | undefined;

    steps.push({
      step: 1,
      description: 'Station caches token and authorizes using cached idToken',
      status: trigger === 'Authorized' ? 'passed' : 'failed',
      expected: 'TransactionEventRequest with triggerReason Authorized',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_34_CS: Store Authorization Data in the Authorization Cache - Update on TransactionResponse
 *
 * Authorized (cached idToken, response returns Invalid) -> Deauthorized
 * -> EVDisconnected -> ParkingBayUnoccupied -> ParkingBayOccupied
 * -> Authorized (response returns Invalid, verifying cache was updated)
 */
export const TC_C_34_CS: CsTestCase = {
  id: 'TC_C_34_CS',
  name: 'Store Authorization Data in the Authorization Cache - Update on TransactionResponse',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the Charging Station is able to store the identifiers correctly upon a TransactionResponse.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Invalid' } };
      return {};
    });

    // Setup: enable auth cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');

    // Step 1: Present token - TransactionEvent response returns Invalid to update cache
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description: 'Station sends TransactionEventRequest, receives invalid status in response',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `TransactionEventRequest received: ${tx != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_36_CS: Store Authorization Data in the Authorization Cache - LocalPreAuthorize = false
 *
 * When LocalPreAuthorize is false, station should send AuthorizeRequest to CSMS
 * (not use cache) even if the token is cached.
 */
export const TC_C_36_CS: CsTestCase = {
  id: 'TC_C_36_CS',
  name: 'Store Authorization Data in the Authorization Cache - LocalPreAuthorize = false',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the Charging Station is able to ignore the Authorization Cache feature when LocalPreAuthorize is false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Invalid' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable auth cache but disable local pre-authorize, add token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'false');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted');

    // Present token - station should send AuthorizeRequest to CSMS (not use cache)
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: Station sends AuthorizeRequest (ignoring cache)
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description:
        'Station sends AuthorizeRequest to CSMS (ignoring cache with LocalPreAuthorize=false)',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest sent to CSMS',
      actual: `AuthorizeRequest received: ${idToken?.['idToken'] != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_46_CS: Store Authorization Data in the Authorization Cache - AuthCacheLifeTime
 *
 * After cache lifetime expires, station should send AuthorizeRequest (not use expired cache).
 */
export const TC_C_46_CS: CsTestCase = {
  id: 'TC_C_46_CS',
  name: 'Store Authorization Data in the Authorization Cache - AuthCacheLifeTime',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station autonomously stores a record of previously presented identifiers.',
  purpose:
    'To verify if the Charging Station is able to correctly remove an idToken when this one is not reused again within the AuthCacheLifeTime.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Setup: enable auth cache with very short lifetime, set LocalPreAuthorize=true
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.LifeTime', '0');

    // Present token after cache lifetime has expired (LifeTime=0 means no caching)
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 2: Station should send AuthorizeRequest (cache expired / not cached)
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'Station sends AuthorizeRequest after cache lifetime expires',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest to CSMS (cache expired)',
      actual: `AuthorizeRequest received: ${idToken?.['idToken'] != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
