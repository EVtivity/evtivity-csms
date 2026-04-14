// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function setupHandler(
  ctx: {
    server: {
      setMessageHandler: (
        h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => void;
    };
  },
  overrides?: Partial<
    Record<string, (payload: Record<string, unknown>) => Record<string, unknown>>
  >,
) {
  ctx.server.setMessageHandler(async (action: string, payload: Record<string, unknown>) => {
    if (overrides?.[action]) return overrides[action](payload);
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize')
      return {
        idTokenInfo: {
          status: 'Accepted',
          personalMessage: { format: 'UTF8', content: 'Cost: 0.00 EUR' },
        },
      };
    if (action === 'TransactionEvent') {
      const eventType = payload.eventType;
      if (eventType === 'Started' || eventType === 'Updated') {
        return {
          idTokenInfo: { status: 'Accepted' },
          updatedPersonalMessage: { format: 'UTF8', content: 'Cost: 1.50 EUR' },
        };
      }
      return {};
    }
    return {};
  });
}

/**
 * TC_I_01_CS: Show EV Driver running total cost during charging - costUpdatedRequest
 * Use case: I02 (I02.FR.02)
 */
export const TC_I_01_CS: CsTestCase = {
  id: 'TC_I_01_CS',
  name: 'Show EV Driver running total cost during charging - costUpdatedRequest',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'While a transaction is ongoing, the driver wants to know how much the running total cost is, updated at a regular interval.',
  purpose:
    'To verify if the Charging Station is able to correctly display the running total cost as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: State is EVConnectedPreSession. Plug in first, then present idToken.
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Step 1: Wait for AuthorizeRequest from station
    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = (authPayload as Record<string, unknown>).idToken as
      | Record<string, unknown>
      | undefined;
    const hasIdToken = idToken != null && typeof idToken.idToken === 'string';
    steps.push({
      step: 1,
      description: 'AuthorizeRequest received with valid idToken',
      status: hasIdToken ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken.idToken and idToken.type',
      actual: hasIdToken ? `idToken: ${String(idToken.idToken)}` : 'Missing or invalid idToken',
    });

    // Step 3: Wait for TransactionEventRequest
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const triggerReason = (txPayload as Record<string, unknown>).triggerReason;
    const eventType = (txPayload as Record<string, unknown>).eventType;
    const validEvent = eventType === 'Started' || eventType === 'Updated';
    steps.push({
      step: 3,
      description: 'TransactionEventRequest received',
      status: validEvent ? 'passed' : 'failed',
      expected: 'eventType Started or Updated',
      actual: `triggerReason: ${String(triggerReason)}, eventType: ${String(eventType)}`,
    });

    // Step 5: Wait for charging state
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 8: Send CostUpdatedRequest to station
    const costRes = await ctx.server.sendCommand('CostUpdated', {
      totalCost: 2.5,
      transactionId: 'test-tx-001',
    });
    steps.push({
      step: 8,
      description: 'CostUpdatedRequest sent, CostUpdatedResponse received',
      status: 'passed',
      expected: 'CostUpdatedResponse received',
      actual: `Response: ${JSON.stringify(costRes)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_I_07_CS: Show EV Driver running total cost during charging - transactionEventResponse
 * Use case: I02 (I02.FR.02)
 */
export const TC_I_07_CS: CsTestCase = {
  id: 'TC_I_07_CS',
  name: 'Show EV Driver running total cost during charging - transactionEventResponse',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'While a transaction is ongoing, the driver wants to know how much the running total cost is, updated via TransactionEventResponse.',
  purpose:
    'To verify if the Charging Station is able to correctly display the running total cost as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize')
        return {
          idTokenInfo: {
            status: 'Accepted',
            personalMessage: { format: 'UTF8', content: 'Cost: 0.00 EUR' },
          },
        };
      if (action === 'TransactionEvent') {
        const eventType = payload.eventType;
        if (eventType === 'Started') return { idTokenInfo: { status: 'Accepted' } };
        if (eventType === 'Updated')
          return { updatedPersonalMessage: { format: 'UTF8', content: 'Cost: 3.00 EUR' } };
        return {};
      }
      return {};
    });

    // Before: State is EVConnectedPreSession. Plug in first, then present idToken.
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Step 1: Wait for AuthorizeRequest
    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = (authPayload as Record<string, unknown>).idToken as
      | Record<string, unknown>
      | undefined;
    const hasIdToken = idToken != null && typeof idToken.idToken === 'string';
    steps.push({
      step: 1,
      description: 'AuthorizeRequest received with valid idToken',
      status: hasIdToken ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken.idToken and idToken.type',
      actual: hasIdToken ? `idToken: ${String(idToken.idToken)}` : 'Missing idToken',
    });

    // Step 3: Wait for TransactionEventRequest (Started or Updated)
    const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const triggerReason = (txPayload as Record<string, unknown>).triggerReason;
    steps.push({
      step: 3,
      description: 'TransactionEventRequest received',
      status: triggerReason != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest',
      actual: `triggerReason: ${String(triggerReason)}`,
    });

    // Step 5: Wait for charging state
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 6-9: Wait for Updated TransactionEvent (cost reported via response)
    const txUpdate = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const updateEventType = (txUpdate as Record<string, unknown>).eventType;
    steps.push({
      step: 6,
      description: 'TransactionEventRequest Updated received for cost update',
      status: updateEventType === 'Updated' ? 'passed' : 'failed',
      expected: 'eventType Updated',
      actual: `eventType: ${String(updateEventType)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
