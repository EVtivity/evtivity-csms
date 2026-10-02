// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import { sleep, waitForChargingState } from '../../../../cs-test-helpers.js';

const MODULE = 'O-display-message';
const EVSE_ID = 1;
const TOKEN = 'OCTT-TOKEN-001';
/** <Configured Priority>. */
const PRIORITY = 'NormalCycle';
/** <Configured supported languages> / <configured not supported languages> / <Configured language1>. */
const SUPPORTED_LANGUAGE = 'en';
const UNSUPPORTED_LANGUAGE = 'ja';
const LANGUAGE1 = 'de';

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');
const result = (steps: StepResult[]): TestResult => ({
  status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
  durationMs: 0,
  steps,
});

function useCsmsHandler(ctx: CsTestContext, authorize?: Record<string, unknown>): void {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return authorize ?? { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

const create = (
  id: string,
  name: string,
  purpose: string,
  execute: (ctx: CsTestContext) => Promise<TestResult>,
): CsTestCase => ({
  id,
  name,
  module: MODULE,
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sets a message on the Charging Station; depending on its parameters it is displayed a certain way and at a certain moment.',
  purpose,
  execute,
});

let nextId = Math.floor(Math.random() * 100_000);

async function setMessage(
  ctx: CsTestContext,
  message: Record<string, unknown>,
): Promise<{ id: number; status: unknown }> {
  const id = ++nextId;
  const resp = await ctx.server.sendCommand('SetDisplayMessage', {
    message: {
      id,
      priority: PRIORITY,
      message: { format: 'UTF8', content: `Message ${String(id)}` },
      ...message,
    },
  });
  return { id, status: resp['status'] };
}

function statusStep(step: number, status: unknown, expected: string): StepResult {
  return {
    step,
    description: `SetDisplayMessageResponse ${expected}`,
    status: passOrFail(status === expected),
    expected,
    actual: String(status),
  };
}

/** Visual inspection: the display shows (or not) the message. */
function displayStep(ctx: CsTestContext, step: number, id: number, shown: boolean): StepResult {
  const displayed = ctx.station.displayedMessage(EVSE_ID);
  return {
    step,
    description: `Visual inspection: the message is ${shown ? '' : 'NOT '}displayed`,
    status: passOrFail((displayed?.id === id) === shown),
    expected: shown ? `message ${String(id)} displayed` : `message ${String(id)} not displayed`,
    actual:
      displayed == null
        ? 'nothing displayed'
        : `message ${String(displayed.id)}: ${displayed.content}`,
  };
}

/** GetDisplayMessages(id) and the NotifyDisplayMessages report; returns the reported message. */
async function reportStep(
  ctx: CsTestContext,
  steps: StepResult[],
  id: number,
  step: number,
  check: (m: Record<string, unknown> | undefined) => boolean,
  expected: string,
): Promise<void> {
  const requestId = Math.floor(Math.random() * 1_000_000);
  const resp = await ctx.server.sendCommand('GetDisplayMessages', { requestId, id: [id] });
  steps.push({
    step,
    description: 'GetDisplayMessagesResponse Accepted',
    status: passOrFail(resp['status'] === 'Accepted'),
    expected: 'Accepted',
    actual: String(resp['status']),
  });
  let report: Record<string, unknown> | null = null;
  try {
    report = await ctx.server.waitForMessage('NotifyDisplayMessages', 10_000);
  } catch {
    report = null;
  }
  const info = ((report?.['messageInfo'] ?? []) as Array<Record<string, unknown>>).find(
    (m) => m['id'] === id,
  );
  steps.push({
    step: step + 1,
    description: `NotifyDisplayMessagesRequest for the request: ${expected}`,
    status: passOrFail(report?.['requestId'] === requestId && check(info)),
    expected: `requestId ${String(requestId)}, ${expected}`,
    actual: report == null ? 'not received' : JSON.stringify(info),
  });
}

async function startEnergyTransfer(ctx: CsTestContext, steps: StepResult[]): Promise<boolean> {
  await ctx.station.plugIn(EVSE_ID);
  await ctx.station.authorize(EVSE_ID, TOKEN);
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  steps.push({
    step: 6,
    description: 'Reusable State EnergyTransferStarted',
    status: passOrFail(charging != null),
    expected: 'chargingState Charging',
    actual: charging != null ? 'Charging' : 'not received',
  });
  return charging != null;
}

async function endSession(ctx: CsTestContext): Promise<void> {
  await ctx.station.authorize(EVSE_ID, TOKEN); // StopAuthorized
  await ctx.station.unplug(EVSE_ID); // EVDisconnected
  await sleep(300);
}

export const TC_O_19_CS = create(
  'TC_O_19_CS',
  'Set Display Message - NotSupportedMessageFormat',
  'To verify that the Charging Station rejects a message format it does not support.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    // <Configured Unsupported Message Format>: the simulator supports ASCII and UTF8
    const set = await setMessage(ctx, { message: { format: 'HTML', content: '<b>Test</b>' } });
    steps.push(statusStep(2, set.status, 'NotSupportedMessageFormat'));
    return result(steps);
  },
);

export const TC_O_20_CS = create(
  'TC_O_20_CS',
  'Set Display Message - Persistent over reboot',
  'To verify that display messages persist over a reboot.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const set = await setMessage(ctx, {});
    steps.push(statusStep(2, set.status, 'Accepted'));
    // Reusable State Booted
    const reset = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
    let booted = reset['status'] === 'Accepted';
    try {
      await ctx.server.waitForMessage('BootNotification', 15_000);
    } catch {
      booted = false;
    }
    steps.push({
      step: 3,
      description: 'Reusable State Booted (Reset, BootNotification)',
      status: passOrFail(booted),
      expected: 'Reset Accepted, BootNotification',
      actual: booted ? 'booted' : `reset ${String(reset['status'])}, no BootNotification`,
    });
    await sleep(500);
    await reportStep(
      ctx,
      steps,
      set.id,
      5,
      (m) =>
        m?.['priority'] === PRIORITY &&
        (m['message'] as Record<string, unknown> | undefined)?.['format'] === 'UTF8' &&
        (m['message'] as Record<string, unknown> | undefined)?.['content'] ===
          `Message ${String(set.id)}`,
      `id ${String(set.id)}, priority ${PRIORITY}, UTF8 content`,
    );
    return result(steps);
  },
);

export const TC_O_22_CS = create(
  'TC_O_22_CS',
  'Set Display Message - Multiple In front priority',
  'To verify that the Charging Station accepts several InFront messages.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const first = await setMessage(ctx, { priority: 'InFront' });
    steps.push(statusStep(2, first.status, 'Accepted'));
    const second = await setMessage(ctx, { priority: 'InFront' });
    steps.push(statusStep(4, second.status, 'Accepted'));
    await reportStep(ctx, steps, first.id, 6, (m) => m?.['priority'] === 'InFront', 'InFront');
    await reportStep(ctx, steps, second.id, 10, (m) => m?.['priority'] === 'InFront', 'InFront');
    return result(steps);
  },
);

export const TC_O_24_CS = create(
  'TC_O_24_CS',
  'Set Display Message - Second Alwaysfront priority',
  'To verify that a second AlwaysFront message replaces the first.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const first = await setMessage(ctx, { priority: 'AlwaysFront' });
    steps.push(statusStep(2, first.status, 'Accepted'));
    const second = await setMessage(ctx, { priority: 'AlwaysFront' });
    steps.push(statusStep(4, second.status, 'Accepted'));
    await reportStep(
      ctx,
      steps,
      second.id,
      6,
      (m) => m?.['priority'] === 'AlwaysFront',
      'AlwaysFront',
    );
    steps.push(displayStep(ctx, 8, second.id, true));
    return result(steps);
  },
);

/** TC_O_36/37: a message for state Charging or Idle around a charging session. */
function sessionStateMessage(state: 'Charging' | 'Idle') {
  return async (ctx: CsTestContext): Promise<TestResult> => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const set = await setMessage(ctx, { state });
    steps.push(statusStep(2, set.status, 'Accepted'));
    steps.push(displayStep(ctx, 2, set.id, state === 'Idle'));
    if (!(await startEnergyTransfer(ctx, steps))) return result(steps);
    steps.push(displayStep(ctx, 6, set.id, state === 'Charging'));
    await endSession(ctx);
    steps.push(displayStep(ctx, 10, set.id, state === 'Idle'));
    await reportStep(ctx, steps, set.id, 12, (m) => m?.['state'] === state, `state ${state}`);
    return result(steps);
  };
}

export const TC_O_36_CS = create(
  'TC_O_36_CS',
  'Set Display Message - State Charging',
  'To verify that a message for state Charging is displayed only while charging.',
  sessionStateMessage('Charging'),
);

export const TC_O_37_CS = create(
  'TC_O_37_CS',
  'Set Display Message - State Idle',
  'To verify that a message for state Idle is displayed only while idle.',
  sessionStateMessage('Idle'),
);

export const TC_O_38_CS = create(
  'TC_O_38_CS',
  'Set Display Message - State Unavailable',
  'To verify that a message for state Unavailable is displayed only while unavailable.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const set = await setMessage(ctx, { state: 'Unavailable' });
    steps.push(statusStep(2, set.status, 'Accepted'));
    steps.push(displayStep(ctx, 2, set.id, false));
    // Reusable State Unavailable
    const down = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    await sleep(500);
    steps.push({
      step: 3,
      description: 'Reusable State Unavailable: ChangeAvailabilityResponse Accepted',
      status: passOrFail(down['status'] === 'Accepted'),
      expected: 'Accepted',
      actual: String(down['status']),
    });
    steps.push(displayStep(ctx, 3, set.id, true));
    const up = await ctx.server.sendCommand('ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    await sleep(500);
    steps.push({
      step: 5,
      description: 'ChangeAvailabilityResponse Accepted (Operative)',
      status: passOrFail(up['status'] === 'Accepted'),
      expected: 'Accepted',
      actual: String(up['status']),
    });
    steps.push(displayStep(ctx, 6, set.id, false));
    await reportStep(
      ctx,
      steps,
      set.id,
      9,
      (m) => m?.['state'] === 'Unavailable',
      'state Unavailable',
    );
    return result(steps);
  },
);

export const TC_O_39_CS = create(
  'TC_O_39_CS',
  'Set Display Message - State Faulted',
  'To verify that a message for state Faulted is displayed only while faulted.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const set = await setMessage(ctx, {
      state: 'Faulted',
      message: { format: 'UTF8', content: 'The Charging Station is out of order' },
    });
    steps.push(statusStep(2, set.status, 'Accepted'));
    steps.push(displayStep(ctx, 2, set.id, false));
    // Manual Action: set the Charging Station to state Faulted
    await ctx.station.injectFault(EVSE_ID, 'OtherError');
    let faulted: Record<string, unknown> | null = null;
    try {
      faulted = await ctx.server.waitForMessage('StatusNotification', 10_000);
    } catch {
      faulted = null;
    }
    steps.push({
      step: 3,
      description: 'The Charging Station reports the Faulted status',
      status: passOrFail(faulted?.['connectorStatus'] === 'Faulted'),
      expected: 'connectorStatus Faulted',
      actual: String(faulted?.['connectorStatus']),
    });
    steps.push(displayStep(ctx, 4, set.id, true));
    // Manual Action: set the Charging Station back to Available
    await ctx.station.clearFault(EVSE_ID);
    await sleep(500);
    steps.push(displayStep(ctx, 6, set.id, false));
    await reportStep(ctx, steps, set.id, 8, (m) => m?.['state'] === 'Faulted', 'state Faulted');
    return result(steps);
  },
);

export const TC_O_100_CS = create(
  'TC_O_100_CS',
  'Set Display Message - unsupported language',
  'To verify that the Charging Station rejects a message in a language it does not support.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const set = await setMessage(ctx, {
      message: { format: 'UTF8', language: SUPPORTED_LANGUAGE, content: 'contentSupported' },
      messageExtra: [
        { format: 'UTF8', language: UNSUPPORTED_LANGUAGE, content: 'contentUnSupported' },
      ],
    });
    steps.push(statusStep(2, set.status, 'LanguageNotSupported'));
    return result(steps);
  },
);

export const TC_O_101_CS = create(
  'TC_O_101_CS',
  'Set Display Message - Language preference of the EV Driver',
  'To verify that the Charging Station shows messages in the language preference of the EV Driver.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx, { idTokenInfo: { status: 'Accepted', language1: LANGUAGE1 } });
    // Manual Action: present the idToken (step 1-2)
    await ctx.station.authorize(EVSE_ID, TOKEN);
    let auth: Record<string, unknown> | null = null;
    try {
      auth = await ctx.server.waitForMessage('Authorize', 10_000);
    } catch {
      auth = null;
    }
    const idToken = auth?.['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'AuthorizeRequest with the idToken',
      status: passOrFail(idToken?.['idToken'] === TOKEN && idToken['type'] != null),
      expected: `idToken ${TOKEN}`,
      actual: JSON.stringify(idToken),
    });
    const set = await setMessage(ctx, {
      message: { format: 'UTF8', language: SUPPORTED_LANGUAGE, content: 'contentSupported' },
      messageExtra: [
        { format: 'UTF8', language: LANGUAGE1, content: 'ContentInCustomerLanguage1' },
      ],
    });
    steps.push(statusStep(4, set.status, 'Accepted'));
    const displayed = ctx.station.displayedMessage(EVSE_ID);
    steps.push({
      step: 4,
      description: 'Visual inspection: ContentInCustomerLanguage1 is shown',
      status: passOrFail(displayed?.content === 'ContentInCustomerLanguage1'),
      expected: 'ContentInCustomerLanguage1',
      actual: displayed == null ? 'nothing displayed' : displayed.content,
    });
    return result(steps);
  },
);
