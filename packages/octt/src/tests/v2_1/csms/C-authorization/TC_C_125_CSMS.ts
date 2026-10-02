// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import { newPspRef, requestAdHocPayment } from '../../../../payment-test-helpers.js';

/** Configured CardLast4Digits of the payment card presented to the terminal. */
const CARD_LAST4 = '1234';
/** Amount the payment terminal authorized, in cents. */
const AUTHORIZED_AMOUNT_CENTS = 5000;

export const TC_C_125_CSMS: TestCase = {
  id: 'TC_C_125_CSMS',
  name: 'Ad hoc payment via stand-alone payment terminal - central cost calculation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'In order to test that Charging Station supports ad hoc payment via a stand-alone payment terminal with central cost calculation.',
  purpose:
    'To verify that the CSMS can properly handle ad hoc payments made via a stand-alone payment terminal with central cost calculation.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootRes['status'])}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    let requestStartPayload: Record<string, unknown> | null = null;
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'RequestStartTransaction') {
        requestStartPayload = payload;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Manual Action: present a payment card to the payment terminal. The terminal
    // reports the authorized payment to the CSMS, which sends RequestStartTransaction.
    const paymentError = await requestAdHocPayment(ctx, {
      pspRef: newPspRef(),
      evseId: 1,
      cardLast4Digits: CARD_LAST4,
      maxCostCents: AUTHORIZED_AMOUNT_CENTS,
    });

    // Step 1 validations: evseId, remoteStartId, idToken, DirectPayment, CardLast4Digits.
    const request = requestStartPayload as Record<string, unknown> | null;
    const reqIdToken = request?.['idToken'] as Record<string, unknown> | undefined;
    const reqIdTokenValue = reqIdToken?.['idToken'] as string | undefined;
    const additionalInfo = reqIdToken?.['additionalInfo'] as Record<string, unknown>[] | undefined;
    const card = additionalInfo?.find((info) => info['type'] === 'CardLast4Digits');
    const requestValid =
      request != null &&
      request['evseId'] === 1 &&
      request['remoteStartId'] != null &&
      reqIdTokenValue != null &&
      reqIdTokenValue !== '' &&
      reqIdToken?.['type'] === 'DirectPayment' &&
      card?.['additionalIdToken'] === CARD_LAST4;
    steps.push({
      step: 2,
      description: 'CSMS sends RequestStartTransaction for the authorized payment',
      status: requestValid ? 'passed' : 'failed',
      expected: `evseId = 1, remoteStartId present, idToken.type = DirectPayment, additionalInfo CardLast4Digits = ${CARD_LAST4}`,
      actual:
        request == null
          ? `RequestStartTransaction not received (${paymentError ?? 'no error'})`
          : `evseId = ${String(request['evseId'])}, remoteStartId = ${String(request['remoteStartId'])}, idToken = ${String(reqIdTokenValue)} (${String(reqIdToken?.['type'])}), CardLast4Digits = ${String(card?.['additionalIdToken'])}`,
    });

    if (request == null || reqIdTokenValue == null) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const txId = `OCTT-TX-${String(Date.now())}`;
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Charging',
        remoteStartId: request['remoteStartId'],
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: reqIdTokenValue,
        type: 'DirectPayment',
        ...(additionalInfo != null ? { additionalInfo } : {}),
      },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 10000, context: 'Transaction.Begin' }],
        },
      ],
    });
    const txLimit = txStartRes['transactionLimit'] as Record<string, unknown> | undefined;
    const maxCost = txLimit?.['maxCost'] as number | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEventResponse (Started) carries transactionLimit.maxCost',
      status: maxCost != null ? 'passed' : 'failed',
      expected: 'transactionLimit.maxCost <not omitted>',
      actual: `transactionLimit.maxCost = ${String(maxCost)}`,
    });

    const txEndRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        stoppedReason: 'Local',
        ...(maxCost != null ? { transactionLimit: { maxCost } } : {}),
      },
      idToken: { idToken: reqIdTokenValue, type: 'DirectPayment' },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 15000, context: 'Transaction.End' }],
        },
      ],
    });
    const totalCost = txEndRes['totalCost'];
    steps.push({
      step: 4,
      description: 'TransactionEventResponse (Ended) carries totalCost (central cost calculation)',
      status: totalCost != null ? 'passed' : 'failed',
      expected: 'totalCost <not omitted>',
      actual: `totalCost = ${String(totalCost)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
