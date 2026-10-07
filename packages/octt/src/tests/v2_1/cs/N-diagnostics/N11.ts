// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { OcppTestServer } from '../../../../cs-server.js';
import { collectMessages } from '../../../../cs-test-helpers.js';
import {
  componentEvse,
  componentName,
  describeEvent,
  EVSE_ID,
  monitoringMemoryState,
  setMonitor,
  useCsmsHandler,
  variableName,
  waitForEvent,
} from './monitoring-shared.js';

/** <Configured severity> of the periodic monitor. */
const SEVERITY = 5;
/** <Configured monitor component> / <Configured monitor component variable>. */
const MONITOR_COMPONENT = { name: 'EVSE', evse: { id: EVSE_ID } };
const MONITOR_VARIABLE = 'Power';

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');

/** Tool validation of a SetVariableMonitoringResponse for the periodic monitor. */
function periodicResultStep(
  step: number,
  result: Record<string, unknown>,
  expectedId?: number,
): StepResult {
  const comp = result['component'] as Record<string, unknown> | undefined;
  const evse = comp?.['evse'] as { id?: number } | undefined;
  const variable = result['variable'] as Record<string, unknown> | undefined;
  return {
    step,
    description: 'SetVariableMonitoringResponse: Periodic monitor Accepted',
    status: passOrFail(
      typeof result['id'] === 'number' &&
        (expectedId == null || result['id'] === expectedId) &&
        result['status'] === 'Accepted' &&
        result['type'] === 'Periodic' &&
        result['severity'] === SEVERITY &&
        comp?.['name'] === MONITOR_COMPONENT.name &&
        evse?.id === EVSE_ID &&
        variable?.['name'] === MONITOR_VARIABLE,
    ),
    expected: `id ${expectedId != null ? String(expectedId) : 'set'}, Accepted, Periodic, severity ${String(SEVERITY)}, EVSE ${String(EVSE_ID)}, ${MONITOR_VARIABLE}`,
    actual: JSON.stringify(result),
  };
}

/** Tool validation of the OpenPeriodicEventStreamRequest. */
function openStreamStep(
  open: Record<string, unknown> | null,
  monitorId: unknown,
  interval: number,
  values?: number,
): StepResult {
  const data = open?.['constantStreamData'] as Record<string, unknown> | undefined;
  const params = data?.['params'] as Record<string, unknown> | undefined;
  return {
    step: 3,
    description: 'OpenPeriodicEventStreamRequest for the monitor',
    status: passOrFail(
      typeof data?.['id'] === 'number' &&
        data['variableMonitoringId'] === monitorId &&
        params?.['interval'] === interval &&
        (values == null || params['values'] === values),
    ),
    expected: `constantStreamData.id set, variableMonitoringId ${String(monitorId)}, params.interval ${String(interval)}${values != null ? `, params.values ${String(values)}` : ''}`,
    actual: open == null ? 'not received' : JSON.stringify(data),
  };
}

async function waitOrNull(
  server: OcppTestServer,
  action: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return server.waitForMessageOrNull(action, timeoutMs);
}

/** Wait for the next NotifyPeriodicEventStream of a stream; returns it with its arrival time. */
async function nextStreamMessage(
  server: OcppTestServer,
  streamId: unknown,
  timeoutMs: number,
): Promise<{ msg: Record<string, unknown>; at: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await waitOrNull(server, 'NotifyPeriodicEventStream', deadline - Date.now());
    if (msg == null) return null;
    if (msg['id'] === streamId) return { msg, at: Date.now() };
  }
  return null;
}

/** Periodic monitor event (NotifyEvent fallback) validation, N11 step 5/14. */
function periodicEventStep(
  step: number,
  found: Awaited<ReturnType<typeof waitForEvent>>,
  monitorId: unknown,
): StepResult {
  const e = found?.event;
  return {
    step,
    description: 'NotifyEventRequest: trigger Periodic for the monitor',
    status: passOrFail(
      found != null &&
        found.request['generatedAt'] != null &&
        e?.['trigger'] === 'Periodic' &&
        e['actualValue'] != null &&
        e['severity'] === SEVERITY &&
        componentName(e) === MONITOR_COMPONENT.name &&
        componentEvse(e)?.id === EVSE_ID &&
        variableName(e) === MONITOR_VARIABLE,
    ),
    expected: `trigger Periodic, actualValue set, monitor ${String(monitorId)}, severity ${String(SEVERITY)}, EVSE ${String(EVSE_ID)}, ${MONITOR_VARIABLE}`,
    actual: describeEvent(found),
  };
}

function useStreamHandler(ctx: CsTestContext, openStatus: 'Accepted' | 'Rejected'): void {
  useCsmsHandler(ctx, { OpenPeriodicEventStream: { status: openStatus } });
}

export const TC_N_105_CS: CsTestCase = {
  id: 'TC_N_105_CS',
  name: 'Set Frequent Periodic Variable Monitoring - Periodic',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To give the CSMS the ability to request efficient frequent periodic monitoring of variables.',
  purpose:
    'To test that Charging Station supports configuring frequent periodic variable monitoring.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useStreamHandler(ctx, 'Accepted');
    await monitoringMemoryState(ctx, steps);

    // Step 1-2
    const result = await setMonitor(ctx.server, {
      type: 'Periodic',
      value: 1,
      severity: SEVERITY,
      component: MONITOR_COMPONENT,
      variable: MONITOR_VARIABLE,
      periodicEventStream: { interval: 10, values: 30 },
    });
    steps.push(periodicResultStep(2, result));
    const monitorId = result['id'];

    // Step 3-4
    const open = await waitOrNull(ctx.server, 'OpenPeriodicEventStream', 10_000);
    steps.push(openStreamStep(open, monitorId, 10, 30));
    const streamId = (open?.['constantStreamData'] as Record<string, unknown> | undefined)?.['id'];

    // Step 5-6
    const get = await ctx.server.sendCommand('GetPeriodicEventStream', {});
    const streams = (get['constantStreamData'] ?? []) as Array<Record<string, unknown>>;
    const listed = streams.find((st) => st['id'] === streamId);
    const listedParams = listed?.['params'] as Record<string, unknown> | undefined;
    steps.push({
      step: 6,
      description: 'GetPeriodicEventStreamResponse lists the stream',
      status: passOrFail(
        listed != null &&
          listed['variableMonitoringId'] === monitorId &&
          listedParams?.['interval'] === 10 &&
          listedParams['values'] === 30,
      ),
      expected: `stream ${String(streamId)}, monitor ${String(monitorId)}, interval 10, values 30`,
      actual: JSON.stringify(streams),
    });

    // Step 7-8: two NotifyPeriodicEventStream messages with 9 or 10 elements
    for (const step of [7, 8]) {
      const sent = await nextStreamMessage(ctx.server, streamId, 15_000);
      const data = (sent?.msg['data'] ?? []) as unknown[];
      steps.push({
        step,
        description: 'NotifyPeriodicEventStream (SEND) with 9 or 10 data elements',
        status: passOrFail(sent != null && (data.length === 9 || data.length === 10)),
        expected: `id ${String(streamId)}, 9 or 10 data elements`,
        actual: sent == null ? 'not received' : `${String(data.length)} data elements`,
      });
    }

    // Step 9-10: the monitor without periodicEventStream
    const update = await setMonitor(ctx.server, {
      id: monitorId as number,
      type: 'Periodic',
      value: 1,
      severity: SEVERITY,
      component: MONITOR_COMPONENT,
      variable: MONITOR_VARIABLE,
    });
    steps.push(periodicResultStep(10, update, monitorId as number));

    // Step 11 (optional flush) and 12: ClosePeriodicEventStreamRequest
    const close = await waitOrNull(ctx.server, 'ClosePeriodicEventStream', 10_000);
    steps.push({
      step: 12,
      description: 'ClosePeriodicEventStreamRequest for the stream',
      status: passOrFail(close != null && close['id'] === streamId),
      expected: `id ${String(streamId)}`,
      actual: close == null ? 'not received' : `id ${String(close['id'])}`,
    });
    ctx.server.clearBuffer();

    // Step 14: NotifyEventRequest every second
    const event = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitorId,
      5000,
    );
    steps.push(periodicEventStep(14, event, monitorId));

    // Post scenario: no NotifyPeriodicEventStream for the stream after step 12
    const late = (
      await collectMessages(ctx.server, 'NotifyPeriodicEventStream', 4000, 4000)
    ).filter((m) => m['id'] === streamId);
    steps.push({
      step: 15,
      description: 'No NotifyPeriodicEventStream for the closed stream',
      status: passOrFail(late.length === 0),
      expected: 'none',
      actual: `${String(late.length)} received`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_106_CS: CsTestCase = {
  id: 'TC_N_106_CS',
  name: 'Set Frequent Periodic Variable Monitoring - CSMS rejects stream',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To give the CSMS the ability to request efficient frequent periodic monitoring of variables.',
  purpose:
    'To test that Charging Station falls back to NotifyEvent if a OpenPeriodicEventRequest is rejected by CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useStreamHandler(ctx, 'Rejected');
    await monitoringMemoryState(ctx, steps);

    // Step 1-2
    const result = await setMonitor(ctx.server, {
      type: 'Periodic',
      value: 1,
      severity: SEVERITY,
      component: MONITOR_COMPONENT,
      variable: MONITOR_VARIABLE,
      periodicEventStream: { interval: 10, values: 30 },
    });
    steps.push(periodicResultStep(2, result));
    const monitorId = result['id'];

    // Step 3-4: the Test System rejects the stream
    const open = await waitOrNull(ctx.server, 'OpenPeriodicEventStream', 10_000);
    steps.push(openStreamStep(open, monitorId, 10, 30));

    // Step 5-6: NotifyEventRequest every second instead
    const event = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitorId,
      5000,
    );
    steps.push(periodicEventStep(5, event, monitorId));

    // The Test System waits 11 seconds: no NotifyPeriodicEventStream
    const streamed = await collectMessages(ctx.server, 'NotifyPeriodicEventStream', 11_000, 11_000);
    steps.push({
      step: 6,
      description: 'No NotifyPeriodicEventStream after the rejected stream',
      status: passOrFail(streamed.length === 0),
      expected: 'none',
      actual: `${String(streamed.length)} received`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_108_CS: CsTestCase = {
  id: 'TC_N_108_CS',
  name: 'Close Periodic Event Streams',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To give the CSMS the ability to request efficient frequent periodic monitoring of variables.',
  purpose:
    'To test that Charging Station closes the periodic event stream when the monitor is cleared.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useStreamHandler(ctx, 'Accepted');
    await monitoringMemoryState(ctx, steps);

    const result = await setMonitor(ctx.server, {
      type: 'Periodic',
      value: 1,
      severity: SEVERITY,
      component: MONITOR_COMPONENT,
      variable: MONITOR_VARIABLE,
      periodicEventStream: { interval: 10, values: 30 },
    });
    steps.push(periodicResultStep(2, result));
    const monitorId = result['id'];
    const open = await waitOrNull(ctx.server, 'OpenPeriodicEventStream', 10_000);
    steps.push(openStreamStep(open, monitorId, 10, 30));
    const streamId = (open?.['constantStreamData'] as Record<string, unknown> | undefined)?.['id'];

    // Step 5-6: ClearVariableMonitoring
    const clear = await ctx.server.sendCommand('ClearVariableMonitoring', { id: [monitorId] });
    const clearResult = (
      (clear['clearMonitoringResult'] ?? []) as Array<Record<string, unknown>>
    )[0];
    steps.push({
      step: 6,
      description: 'ClearVariableMonitoringResponse: Accepted for the monitor',
      status: passOrFail(clearResult?.['status'] === 'Accepted' && clearResult['id'] === monitorId),
      expected: `status Accepted, id ${String(monitorId)}`,
      actual: JSON.stringify(clearResult),
    });

    // Step 7-8: ClosePeriodicEventStreamRequest
    const close = await waitOrNull(ctx.server, 'ClosePeriodicEventStream', 10_000);
    steps.push({
      step: 7,
      description: 'ClosePeriodicEventStreamRequest for the stream',
      status: passOrFail(close != null && close['id'] === streamId),
      expected: `id ${String(streamId)}`,
      actual: close == null ? 'not received' : `id ${String(close['id'])}`,
    });
    ctx.server.clearBuffer();

    // Post scenario: no NotifyPeriodicEventStream for the stream (one interval and more)
    const late = (
      await collectMessages(ctx.server, 'NotifyPeriodicEventStream', 12_000, 12_000)
    ).filter((m) => m['id'] === streamId);
    steps.push({
      step: 9,
      description: 'No NotifyPeriodicEventStream for the closed stream',
      status: passOrFail(late.length === 0),
      expected: 'none',
      actual: `${String(late.length)} received`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_109_CS: CsTestCase = {
  id: 'TC_N_109_CS',
  name: 'Adjust Periodic Event Streams',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To adjust the transmission rate of a periodic event stream.',
  purpose: 'To test that Charging Station supports adjust periodic event streams.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useStreamHandler(ctx, 'Accepted');
    await monitoringMemoryState(ctx, steps);

    const result = await setMonitor(ctx.server, {
      type: 'Periodic',
      value: 1,
      severity: SEVERITY,
      component: MONITOR_COMPONENT,
      variable: MONITOR_VARIABLE,
      periodicEventStream: { interval: 10 },
    });
    steps.push(periodicResultStep(2, result));
    const monitorId = result['id'];
    const open = await waitOrNull(ctx.server, 'OpenPeriodicEventStream', 10_000);
    steps.push(openStreamStep(open, monitorId, 10));
    const streamId = (open?.['constantStreamData'] as Record<string, unknown> | undefined)?.['id'];

    // Steps 5-7 (10 s apart) and 10-12 (15 s apart, after AdjustPeriodicEventStream)
    const checkSeries = async (first: number, intervalS: number): Promise<void> => {
      let previous: number | null = null;
      for (let i = 0; i < 3; i++) {
        const sent = await nextStreamMessage(ctx.server, streamId, (intervalS + 5) * 1000);
        const gapS = sent != null && previous != null ? (sent.at - previous) / 1000 : null;
        steps.push({
          step: first + i,
          description: `NotifyPeriodicEventStream (SEND)${previous != null ? ` about ${String(intervalS)} s after the previous one` : ''}`,
          status: passOrFail(sent != null && (gapS == null || Math.abs(gapS - intervalS) <= 2)),
          expected: `id ${String(streamId)}${previous != null ? `, ${String(intervalS)} s apart` : ''}`,
          actual:
            sent == null
              ? 'not received'
              : `id ${String(sent.msg['id'])}${gapS != null ? `, ${gapS.toFixed(1)} s apart` : ''}`,
        });
        previous = sent?.at ?? previous;
      }
    };
    await checkSeries(5, 10);

    // Step 8-9: AdjustPeriodicEventStreamRequest interval 15
    const adjust = await ctx.server.sendCommand('AdjustPeriodicEventStream', {
      id: streamId,
      params: { interval: 15 },
    });
    steps.push({
      step: 9,
      description: 'AdjustPeriodicEventStreamResponse: Accepted',
      status: passOrFail(adjust['status'] === 'Accepted'),
      expected: 'status Accepted',
      actual: `status ${String(adjust['status'])}`,
    });
    await checkSeries(10, 15);

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
