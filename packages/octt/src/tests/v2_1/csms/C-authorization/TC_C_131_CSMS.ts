// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase, StepResult } from '../../../../types.js';
import { newPspRef, requestAdHocPayment } from '../../../../payment-test-helpers.js';
import {
  buildQrUrl,
  captureWebPayments,
  enableDynamicQr,
  stationTotp,
  visitQrUrl,
} from '../../../../qr-test-helpers.js';

/** maxenergy the EV driver entered before the QR code was shown (Wh). */
const MAX_ENERGY_WH = 20000;

export const TC_C_131_CSMS: TestCase = {
  id: 'TC_C_131_CSMS',
  name: 'Ad hoc payment via static or dynamic QR code - success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'In order to test that CSMS supports QR codes.',
  purpose:
    'To verify if the CSMS is able to respond correctly when a QR code is scanned on Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Boot the station
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

    // Step 2: Wait for CSMS to send RequestStartTransaction after QR code payment
    let requestStartReceived = false;
    let requestStartPayload: Record<string, unknown> = {};

    const capture = captureWebPayments();
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      const setVariables = capture.handle(action, payload);
      if (setVariables != null) return setVariables;
      if (action === 'RequestStartTransaction') {
        requestStartReceived = true;
        requestStartPayload = payload;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Prerequisite: the CSMS configures the station's dynamic QR code
    // (WebPaymentsCtrlr URLTemplate, TOTP parameters, shared secret).
    const configError = await enableDynamicQr(ctx, capture);

    // Manual Action: the EV driver scans the QR code (maxenergy 20000) and opens
    // the CSMS web page, which checks the URL and its one-time password.
    const qrUrl =
      configError == null
        ? buildQrUrl(capture.values['URLTemplate'] ?? '', {
            chargingStationId: ctx.stationId,
            evseId: 1,
            totp: stationTotp(capture.values),
            version: capture.values['TOTPVersion'] ?? '',
            query: `maxenergy=${String(MAX_ENERGY_WH)}`,
          })
        : null;
    const visit = qrUrl != null ? await visitQrUrl(ctx, qrUrl) : (configError ?? 'not configured');
    const qrValid =
      typeof visit !== 'string' &&
      visit.valid &&
      visit.stationId === ctx.stationId &&
      visit.evseId === 1;
    steps.push({
      step: 2,
      description: 'CSMS accepts the QR code URL with a valid TOTP',
      status: qrValid ? 'passed' : 'failed',
      expected: `valid, chargingstationid = ${ctx.stationId}, evse = 1`,
      actual: typeof visit === 'string' ? visit : JSON.stringify(visit),
    });

    // The payment provider then reports the authorized payment (its PspRef)
    // to the CSMS, which sends RequestStartTransaction for the EVSE from the URL.
    const pspRef = newPspRef();
    const paymentError = qrValid
      ? await requestAdHocPayment(ctx, { pspRef, evseId: 1, maxEnergyWh: MAX_ENERGY_WH })
      : 'QR code URL not valid';

    const reqIdToken = requestStartPayload['idToken'] as Record<string, unknown> | undefined;
    const reqIdTokenValue = reqIdToken?.['idToken'] as string | undefined;
    const reqIdTokenType = reqIdToken?.['type'] as string | undefined;

    steps.push({
      step: 3,
      description: 'CSMS sends RequestStartTransaction with DirectPayment idToken',
      status:
        requestStartReceived && reqIdTokenValue === pspRef && reqIdTokenType === 'DirectPayment'
          ? 'passed'
          : 'failed',
      expected: `RequestStartTransaction with idToken.idToken = ${pspRef}, idToken.type = DirectPayment`,
      actual: requestStartReceived
        ? `idToken.idToken = ${String(reqIdTokenValue)}, idToken.type = ${String(reqIdTokenType)}`
        : `RequestStartTransaction not received (${paymentError ?? 'no error'})`,
    });

    if (!requestStartReceived) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const txId = `OCTT-TX-${String(Date.now())}`;
    const remoteStartId = requestStartPayload['remoteStartId'] as number | undefined;

    // Step 3: Send TransactionEvent Started
    const txStartRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Charging',
        remoteStartId,
      },
      evse: { id: 1, connectorId: 1 },
      idToken: {
        idToken: reqIdTokenValue,
        type: 'DirectPayment',
      },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: 10000, context: 'Transaction.Begin' }],
        },
      ],
    });

    const txIdTokenInfo = txStartRes['idTokenInfo'] as Record<string, unknown> | undefined;
    const txStatus = txIdTokenInfo?.['status'] as string | undefined;
    const txLimit = txStartRes['transactionLimit'] as Record<string, unknown> | undefined;
    const maxEnergy = txLimit?.['maxEnergy'] as number | undefined;

    steps.push({
      step: 4,
      description: 'Send TransactionEvent Started with RemoteStart trigger',
      status: txStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${String(txStatus)}`,
    });

    steps.push({
      step: 5,
      description: 'Verify transactionLimit.maxEnergy is set to 20000',
      status: maxEnergy === MAX_ENERGY_WH ? 'passed' : 'failed',
      expected: 'transactionLimit.maxEnergy = 20000',
      actual: `transactionLimit.maxEnergy = ${String(maxEnergy)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
