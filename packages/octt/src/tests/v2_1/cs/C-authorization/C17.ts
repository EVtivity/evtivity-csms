// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState, waitForMatchingMessage } from '../../../../cs-test-helpers.js';

const EVSE_ID = 1;
/** <prepaid card id>: the card the EV driver presents (Manual Action). */
const PREPAID_CARD = 'OCTT-PREPAID-001';
const PREPAID_CARD_TYPE = 'ISO14443';
const PREPAID_TYPES = ['ISO14443', 'ISO15693'];

const now = (): string => new Date().toISOString();

function result(steps: StepResult[]): {
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepResult[];
} {
  return {
    status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
    durationMs: 0,
    steps,
  };
}

/** Step 1 validation: AuthorizeRequest with the prepaid card id and an RFID type. */
function authorizeStep(authorize: Record<string, unknown> | null): StepResult {
  const idToken = authorize?.['idToken'] as Record<string, unknown> | undefined;
  return {
    step: 1,
    description: 'AuthorizeRequest with the prepaid card',
    status:
      idToken?.['idToken'] === PREPAID_CARD && PREPAID_TYPES.includes(String(idToken['type']))
        ? 'passed'
        : 'failed',
    expected: `idToken.idToken = ${PREPAID_CARD}, idToken.type = ISO14443 or ISO15693`,
    actual: authorize != null ? `idToken = ${JSON.stringify(idToken)}` : 'no AuthorizeRequest',
  };
}

/**
 * TC_C_103_CS: Authorization with prepaid card - success
 *
 * The Test System answers the prepaid card with Accepted and cacheExpiryDateTime now
 * (C17.FR.01), and the TransactionEventResponse carries transactionLimit.maxCost
 * (C17.FR.03). The Charging Station offers energy (C17.FR.04).
 */
export const TC_C_103_CS: CsTestCase = {
  id: 'TC_C_103_CS',
  name: 'Authorization with prepaid card - success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'This test case verifies if the CS communicates the transaction limits correctly.',
  purpose:
    'To verify if the Charging Station correctly handles prepaid card authorization with transaction limits.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action, payload) => {
      if (action === 'BootNotification')
        return { currentTime: now(), interval: 300, status: 'Accepted' };
      if (action === 'Heartbeat') return { currentTime: now() };
      // Step 2
      if (action === 'Authorize')
        return { idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: now() } };
      // Step 4: the response to the TransactionEventRequest with the prepaid idToken
      if (action === 'TransactionEvent' && payload['idToken'] != null)
        return {
          idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: now() },
          transactionLimit: { maxCost: 123.32 },
        };
      return {};
    });

    // Manual Action: EV driver presents prepaid card
    await ctx.station.authorize(EVSE_ID, PREPAID_CARD, PREPAID_CARD_TYPE);

    // Step 1: AuthorizeRequest
    const authorize = await ctx.server.waitForMessage('Authorize', 10_000).catch(() => null);
    steps.push(authorizeStep(authorize));
    const authorizeType = (authorize?.['idToken'] as Record<string, unknown> | undefined)?.['type'];

    // Manual Action: plug cable in (TxStartPoint contains neither ParkingBayOccupancy nor
    // Authorized alone: the simulator starts the transaction once authorized and connected)
    await ctx.station.plugIn(EVSE_ID);

    // Step 3: the first TransactionEventRequest with the prepaid idToken
    const tx = await waitForMatchingMessage(
      ctx.server,
      'TransactionEvent',
      (p) => p['idToken'] != null,
      15_000,
    );
    const txToken = tx?.['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEventRequest Started with the prepaid idToken',
      status:
        tx?.['eventType'] === 'Started' &&
        txToken?.['idToken'] === PREPAID_CARD &&
        txToken['type'] === authorizeType
          ? 'passed'
          : 'failed',
      expected: `eventType Started, idToken.idToken ${PREPAID_CARD}, idToken.type ${String(authorizeType)}`,
      actual:
        tx != null
          ? `eventType ${String(tx['eventType'])}, idToken ${JSON.stringify(txToken)}`
          : 'no TransactionEventRequest with idToken',
    });

    // Post scenario: transactionInfo.chargingState transitions to Charging
    const charging = await waitForChargingState(ctx.server, 'Charging', 15_000);
    steps.push({
      step: 5,
      description: 'Post scenario: transactionInfo.chargingState transitions to Charging',
      status: charging != null ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: charging != null ? 'chargingState Charging' : 'no Charging state reported',
    });

    return result(steps);
  },
};

/**
 * TC_C_104_CS: Authorization with prepaid card - no credit
 *
 * The Test System answers the prepaid card with NoCredit and cacheExpiryDateTime now
 * (C17.FR.02). The Charging Station does not offer energy (C17.FR.05).
 */
export const TC_C_104_CS: CsTestCase = {
  id: 'TC_C_104_CS',
  name: 'Authorization with prepaid card - no credit',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'This test case verifies if the CS communicates the transaction limits correctly.',
  purpose:
    'To verify that the Charging Station is able to handle when a prepaid card has no credit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: now(), interval: 300, status: 'Accepted' };
      if (action === 'Heartbeat') return { currentTime: now() };
      // Step 2
      if (action === 'Authorize')
        return { idTokenInfo: { status: 'NoCredit', cacheExpiryDateTime: now() } };
      return {};
    });

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(EVSE_ID);

    // Manual Action: EV driver presents prepaid card
    await ctx.station.authorize(EVSE_ID, PREPAID_CARD, PREPAID_CARD_TYPE);

    // Step 1: AuthorizeRequest
    const authorize = await ctx.server.waitForMessage('Authorize', 10_000).catch(() => null);
    steps.push(authorizeStep(authorize));

    // Post scenario: no TransactionEventRequest (the simulator's TxStartPoint does not
    // contain ParkingBayOccupancy), so no transaction and no energy offered.
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10_000).catch(() => null);
    steps.push({
      step: 3,
      description: 'Post scenario: no TransactionEventRequest and no energy offered',
      status: tx == null ? 'passed' : 'failed',
      expected: 'no TransactionEventRequest',
      actual:
        tx != null
          ? `TransactionEventRequest ${String(tx['eventType'])} (${String(tx['triggerReason'])})`
          : 'no TransactionEventRequest',
    });

    return result(steps);
  },
};
