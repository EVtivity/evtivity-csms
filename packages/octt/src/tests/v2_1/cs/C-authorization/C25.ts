// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import {
  collectMessages,
  setVariables,
  waitForMatchingMessage,
} from '../../../../cs-test-helpers.js';
import { stationTotp } from '../../../../qr-test-helpers.js';

const EVSE_ID = 1;
/** <Configured pspref_idtoken>: the payment reference the CSMS starts the transaction with. */
const PSP_REF = 'OCTT-PSPREF-001';
const SHARED_SECRET = '12345678';
const VALIDITY_SECONDS = 120;
const TOTP_LENGTH = 8;
/** The station's URL template (product configuration, not part of the Configuration State). */
const URL_TEMPLATE = 'https://qr.octt.test/{chargingstationid}/{evse}/{totp}/{version}';

type LimitField = 'maxTime' | 'maxCost' | 'maxEnergy';
interface QrLimit {
  field: LimitField;
  /** WebPaymentsCtrlr.URLParameters entry and QR URL query parameter. */
  param: string;
  value: number;
}

const now = (): string => new Date().toISOString();
const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');

/**
 * TC_C_127_CS to TC_C_130_CS: ad hoc payment via a dynamic QR code (C25), without URL
 * parameters or with the limit the EV driver entered.
 */
async function runQrPayment(ctx: CsTestContext, limit: QrLimit | null): Promise<TestResult> {
  const steps: StepResult[] = [];

  ctx.server.setMessageHandler(async (action, payload) => {
    if (action === 'BootNotification')
      return { currentTime: now(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: now() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    // The first TransactionEventResponse (to the request with the idToken)
    if (action === 'TransactionEvent' && payload['idToken'] != null) {
      const response: Record<string, unknown> = { idTokenInfo: { status: 'Accepted' } };
      if (limit != null) response['transactionLimit'] = { [limit.field]: limit.value };
      return response;
    }
    return {};
  });

  // Configuration State
  const notAccepted = await setVariables(ctx.server, [
    { component: 'TariffCostCtrlr', variable: 'Enabled', instance: 'Tariff', value: 'true' },
    { component: 'TariffCostCtrlr', variable: 'Enabled', instance: 'Cost', value: 'true' },
    { component: 'TariffCostCtrlr', variable: 'Currency', value: 'EUR' },
    { component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart', value: 'true' },
    { component: 'WebPaymentsCtrlr', variable: 'Enabled', value: 'true' },
    { component: 'WebPaymentsCtrlr', variable: 'TOTPVersion', value: 'v1' },
    { component: 'WebPaymentsCtrlr', variable: 'ValidityTime', value: String(VALIDITY_SECONDS) },
    { component: 'WebPaymentsCtrlr', variable: 'SharedSecret', value: SHARED_SECRET },
    { component: 'WebPaymentsCtrlr', variable: 'Length', value: String(TOTP_LENGTH) },
  ]);
  steps.push({
    step: 0,
    description: 'Before: Configuration State (TariffCostCtrlr, AuthCtrlr, WebPaymentsCtrlr)',
    status: passOrFail(notAccepted.length === 0),
    expected: 'all SetVariables Accepted',
    actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
  });

  // Steps 1-2: SetDefaultTariff
  const tariffRes = await ctx.server.sendCommand('SetDefaultTariff', {
    evseId: 0,
    tariff: {
      tariffId: 'Test System1',
      currency: 'EUR',
      fixedFee: { taxRates: [{ type: 'MyTax', tax: 21 }], prices: [{ priceFixed: 12.45 }] },
    },
  });
  steps.push({
    step: 2,
    description: 'SetDefaultTariffResponse',
    status: passOrFail(tariffRes['status'] === 'Accepted'),
    expected: 'status Accepted',
    actual: `status ${String(tariffRes['status'])}`,
  });

  // Manual Action: the EV driver enters the limit for the transaction (C25.FR.03)
  if (limit != null) {
    ctx.station.enterWebPaymentLimits(EVSE_ID, { [limit.field]: limit.value });
  }

  // The Charging Station displays a dynamic QR code. Simulate starting a transaction with
  // it: the EV driver scans it and the web page validates the TOTP (C25.FR.07).
  const qrUrl = ctx.station.webPaymentQrUrl(EVSE_ID);
  const match = /\/([^/?]+)\/(\d+)\/([^/?]+)\/(v1)(?:\?(.*))?$/.exec(qrUrl ?? '');
  // Validation of TOTP: the current, previous, or next interval (C25.FR.07)
  const totpValues = {
    SharedSecret: SHARED_SECRET,
    ValidityTime: String(VALIDITY_SECONDS),
    Length: String(TOTP_LENGTH),
  };
  const scannedAt = Date.now();
  const totpValid =
    match != null &&
    [0, -1, 1].some(
      (k) => stationTotp(totpValues, scannedAt + k * VALIDITY_SECONDS * 1000) === match[3],
    );
  const query = new URLSearchParams(match?.[5] ?? '');
  const expectedQuery = limit != null ? `${limit.param}=${String(limit.value)}` : '';
  steps.push({
    step: 2,
    description: 'Simulated scan: dynamic QR code with a valid TOTP for the EVSE',
    status: passOrFail(
      totpValid && match?.[2] === String(EVSE_ID) && query.toString() === expectedQuery,
    ),
    expected: `{chargingstationid}/${String(EVSE_ID)}/<valid TOTP>/v1${expectedQuery !== '' ? `?${expectedQuery}` : ''}`,
    actual: qrUrl ?? 'no QR code displayed',
  });

  // Steps 3-4: NotifyWebPaymentStarted
  const notifyRes = await ctx.server.sendCommand('NotifyWebPaymentStarted', {
    evseId: EVSE_ID,
    timeout: 5,
  });
  steps.push({
    step: 4,
    description: 'NotifyWebPaymentStartedResponse',
    status: passOrFail(Object.keys(notifyRes).length === 0),
    expected: 'response without parameters',
    actual: JSON.stringify(notifyRes),
  });

  // Step 5: Reusable State AuthorizedPaymentTerminal (Remote)
  const startRes = await ctx.server.sendCommand('RequestStartTransaction', {
    evseId: EVSE_ID,
    remoteStartId: 127,
    idToken: { idToken: PSP_REF, type: 'DirectPayment' },
  });
  steps.push({
    step: 5,
    description: 'AuthorizedPaymentTerminal (Remote): RequestStartTransactionResponse',
    status: passOrFail(startRes['status'] === 'Accepted'),
    expected: 'status Accepted',
    actual: `status ${String(startRes['status'])}`,
  });
  // AuthCtrlr.AuthorizeRemoteStart is true: the station authorizes the idToken first
  const authorize = await ctx.server.waitForMessage('Authorize', 10_000).catch(() => null);
  const authToken = authorize?.['idToken'] as Record<string, unknown> | undefined;
  steps.push({
    step: 5,
    description: 'AuthorizedPaymentTerminal (Remote): AuthorizeRequest',
    status: passOrFail(authToken?.['idToken'] === PSP_REF && authToken['type'] === 'DirectPayment'),
    expected: `idToken.idToken ${PSP_REF}, idToken.type DirectPayment`,
    actual: authorize != null ? `idToken ${JSON.stringify(authToken)}` : 'no AuthorizeRequest',
  });

  // Step 6: Reusable State EVConnectedPreSession
  await ctx.station.plugIn(EVSE_ID);

  // Steps 5-7 combined: the first TransactionEventRequest with idToken
  const first = await waitForMatchingMessage(
    ctx.server,
    'TransactionEvent',
    (p) => p['idToken'] != null,
    15_000,
  );
  const firstToken = first?.['idToken'] as Record<string, unknown> | undefined;
  const firstInfo = first?.['transactionInfo'] as Record<string, unknown> | undefined;
  const firstLimit = firstInfo?.['transactionLimit'] as Record<string, unknown> | undefined;
  const limitOk = limit == null ? firstLimit == null : firstLimit?.[limit.field] === limit.value;
  steps.push({
    step: 7,
    description: 'First TransactionEventRequest with idToken',
    status: passOrFail(
      firstToken?.['idToken'] != null &&
        firstToken['idToken'] !== '' &&
        firstToken['type'] === 'DirectPayment' &&
        typeof firstInfo?.['transactionId'] === 'string' &&
        limitOk,
    ),
    expected: `idToken not empty, type DirectPayment, transactionId, ${
      limit == null
        ? 'transactionLimit omitted'
        : `transactionLimit.${limit.field} ${String(limit.value)}`
    }`,
    actual:
      first != null
        ? `idToken ${JSON.stringify(firstToken)}, transactionId ${String(firstInfo?.['transactionId'])}, transactionLimit ${JSON.stringify(firstLimit)}`
        : 'no TransactionEventRequest with idToken',
  });

  // Step 7: Reusable State EnergyTransferStarted, and steps 8-9 for a limit
  const later = await collectMessages(ctx.server, 'TransactionEvent', 3_000, 20_000);
  const charging = later.some(
    (p) =>
      (p['transactionInfo'] as Record<string, unknown> | undefined)?.['chargingState'] ===
      'Charging',
  );
  steps.push({
    step: 7,
    description: 'EnergyTransferStarted: chargingState Charging',
    status: passOrFail(charging),
    expected: 'chargingState Charging',
    actual: charging ? 'chargingState Charging' : 'no Charging state reported',
  });

  if (limit != null) {
    const limitSet = later.find((p) => p['triggerReason'] === 'LimitSet');
    const setLimit = (limitSet?.['transactionInfo'] as Record<string, unknown> | undefined)?.[
      'transactionLimit'
    ] as Record<string, unknown> | undefined;
    steps.push({
      step: 8,
      description: `TransactionEventRequest LimitSet with ${limit.field}`,
      status: passOrFail(limitSet != null && setLimit?.[limit.field] === limit.value),
      expected: `triggerReason LimitSet, transactionLimit.${limit.field} ${String(limit.value)}`,
      actual:
        limitSet != null
          ? `transactionLimit ${JSON.stringify(setLimit)}`
          : 'no TransactionEventRequest with triggerReason LimitSet',
    });
  }

  return {
    status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
    durationMs: 0,
    steps,
  };
}

const create = (
  id: string,
  name: string,
  purpose: string,
  urlParameters: string,
  limit: QrLimit | null,
): CsTestCase => ({
  id,
  name,
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To provide a static or dynamic QR code with a URL for ad hoc payment',
  purpose,
  // WebPaymentsCtrlr.URLParameters is ReadOnly: the Configuration State names the variant
  stationConfig: {
    configOverrides: {
      'WebPaymentsCtrlr.URLTemplate': URL_TEMPLATE,
      'WebPaymentsCtrlr.URLParameters': urlParameters,
    },
  },
  execute: (ctx) => runQrPayment(ctx, limit),
});

/** TC_C_127_CS: WebPaymentsCtrlr.URLParameters is absent or empty. */
export const TC_C_127_CS = create(
  'TC_C_127_CS',
  'Ad hoc payment via static or dynamic QR code - no URL parameters',
  'To verify if the Charging Station supports ad hoc payments with a url without URL parameters.',
  '',
  null,
);

/** TC_C_128_CS: Manual Action: enter time limit 300 for the transaction. */
export const TC_C_128_CS = create(
  'TC_C_128_CS',
  'Ad hoc payment via static or dynamic QR code - URL parameter maxTime',
  'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxTime.',
  'maxtime',
  { field: 'maxTime', param: 'maxtime', value: 300 },
);

/** TC_C_129_CS: Manual Action: enter cost limit 50.00 for the transaction. */
export const TC_C_129_CS = create(
  'TC_C_129_CS',
  'Ad hoc payment via static or dynamic QR code - URL parameter maxCost',
  'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxCost.',
  'maxcost',
  { field: 'maxCost', param: 'maxcost', value: 50 },
);

/** TC_C_130_CS: Manual Action: enter energy limit 20000 for the transaction. */
export const TC_C_130_CS = create(
  'TC_C_130_CS',
  'Ad hoc payment via static or dynamic QR code - URL parameter maxEnergy',
  'To verify if the Charging Station supports ad hoc payments with a url with URL parameters maxEnergy.',
  'maxenergy',
  { field: 'maxEnergy', param: 'maxenergy', value: 20000 },
);
