// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

const ENTER_SERVICE_ID = 'enterservice_1';
const FREQ_DROOP_ID = 'freqdroop_1';
const FREQ_WATT_ID = 'freqwatt_1';

const FREQ_DROOP = {
  priority: 6,
  overFreq: 50.5,
  underFreq: 49.5,
  overDroop: 0.05,
  underDroop: 0.05,
  responseTime: 10,
};
const ENTER_SERVICE = {
  priority: 1,
  highVoltage: 250,
  lowVoltage: 210,
  highFreq: 50.5,
  lowFreq: 49.5,
};
const FREQ_WATT_CURVE_DATA = [
  { x: 49, y: 75 },
  { x: 49.5, y: 90 },
  { x: 50.5, y: 100 },
  { x: 51, y: 100 },
];

/** Checks one CSMS request against the doc's tool validation; returns the mismatch or null. */
type Check = (payload: Record<string, unknown>) => string | null;

export const TC_R_107_CSMS: TestCase = {
  id: 'TC_R_107_CSMS',
  name: 'Configure DER control settings at CS',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'Setting some DER controls and reboot the charging station. After reboot, retrieving the configured DER controls.',
  purpose: 'To check if the CSMS is able to set DER Controls.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // The Test System answers every DER request Accepted (steps 2, 4, 6, 8, 10, 12, 16, 20, 22)
    // and keeps the requests for the tool validations.
    const received: { action: string; payload: Record<string, unknown> }[] = [];
    ctx.client.setIncomingCallHandler(async (_mid, action, payload) => {
      if (
        action === 'ClearDERControl' ||
        action === 'SetDERControl' ||
        action === 'GetDERControl'
      ) {
        received.push({ action, payload });
        return { status: 'Accepted' };
      }
      return defaultReply('ocpp2.1', action, payload);
    });

    /**
     * Manual action: trigger the CSMS to send `action`, then validate the request
     * it sent (the doc's step `step`).
     */
    const triggerAndCheck = async (
      step: number,
      action: 'ClearDERControl' | 'SetDERControl' | 'GetDERControl',
      body: Record<string, unknown>,
      expected: string,
      check: Check,
    ): Promise<void> => {
      const description = `CSMS sends ${action}Request`;
      if (ctx.triggerCommand == null) {
        steps.push({ step, description, status: 'failed', expected, actual: 'No API client' });
        return;
      }
      const before = received.length;
      try {
        await ctx.triggerCommand('v21', action, { stationId: ctx.stationId, ...body });
      } catch (err) {
        steps.push({
          step,
          description,
          status: 'failed',
          expected,
          actual: `Trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const request = received.slice(before).find((r) => r.action === action);
      const mismatch = request == null ? `${action}Request not received` : check(request.payload);
      steps.push({
        step,
        description,
        status: mismatch == null ? 'passed' : 'failed',
        expected,
        actual: mismatch ?? 'As expected',
      });
    };

    const equals =
      (field: string, value: unknown): Check =>
      (p) =>
        p[field] === value ? null : `${field} = ${JSON.stringify(p[field])}`;
    const all =
      (...checks: Check[]): Check =>
      (p) =>
        checks.map((c) => c(p)).find((m) => m != null) ?? null;
    const nested =
      (field: string, check: (v: Record<string, unknown>) => string | null): Check =>
      (p) => {
        const v = p[field] as Record<string, unknown> | undefined;
        return v == null ? `${field} omitted` : check(v);
      };

    // Test ClearDERControl
    await triggerAndCheck(
      1,
      'ClearDERControl',
      { isDefault: true },
      'isDefault true',
      equals('isDefault', true),
    );
    await triggerAndCheck(
      3,
      'ClearDERControl',
      { isDefault: false },
      'isDefault false',
      equals('isDefault', false),
    );

    // Test SetDERControl
    await triggerAndCheck(
      5,
      'SetDERControl',
      {
        isDefault: true,
        controlId: FREQ_DROOP_ID,
        controlType: 'FreqDroop',
        freqDroop: FREQ_DROOP,
      },
      'isDefault true, controlType FreqDroop, freqDroop.priority 6, no startTime/duration',
      all(
        equals('isDefault', true),
        equals('controlType', 'FreqDroop'),
        nested('freqDroop', (f) =>
          f['priority'] !== 6
            ? `freqDroop.priority = ${String(f['priority'])}`
            : f['startTime'] != null || f['duration'] != null
              ? 'freqDroop.startTime/duration present'
              : null,
        ),
      ),
    );
    const startTime = new Date().toISOString();
    await triggerAndCheck(
      7,
      'SetDERControl',
      {
        isDefault: false,
        controlId: FREQ_WATT_ID,
        controlType: 'FreqWatt',
        curve: {
          priority: 4,
          yUnit: 'PctMaxW',
          curveData: FREQ_WATT_CURVE_DATA,
          startTime,
          duration: 900,
        },
      },
      'isDefault false, controlType FreqWatt, curve.priority 4, startTime present, duration 900, curveData x/y',
      all(
        equals('isDefault', false),
        equals('controlType', 'FreqWatt'),
        nested('curve', (c) => {
          if (c['priority'] !== 4) return `curve.priority = ${String(c['priority'])}`;
          if (c['startTime'] == null) return 'curve.startTime omitted';
          if (c['duration'] !== 900) return `curve.duration = ${String(c['duration'])}`;
          const data = c['curveData'] as Record<string, unknown>[] | undefined;
          if (data == null || data.length === 0) return 'curve.curveData omitted';
          return data.every((d) => d['x'] != null && d['y'] != null)
            ? null
            : 'curve.curveData x/y omitted';
        }),
      ),
    );
    await triggerAndCheck(
      9,
      'SetDERControl',
      {
        isDefault: false,
        controlId: ENTER_SERVICE_ID,
        controlType: 'EnterService',
        enterService: ENTER_SERVICE,
      },
      'isDefault false, controlType EnterService, enterService.priority 1',
      all(
        equals('isDefault', false),
        equals('controlType', 'EnterService'),
        nested('enterService', (e) =>
          e['priority'] === 1 ? null : `enterService.priority = ${String(e['priority'])}`,
        ),
      ),
    );

    // Test GetDERControl
    await triggerAndCheck(
      11,
      'GetDERControl',
      { requestId: 1, isDefault: true },
      'isDefault true',
      equals('isDefault', true),
    );
    const report1 = received.filter((r) => r.action === 'GetDERControl').at(-1);
    if (report1 != null) {
      try {
        const resp = await ctx.client.sendCall('ReportDERControl', {
          requestId: report1.payload['requestId'],
          enterService: [{ id: ENTER_SERVICE_ID, enterService: ENTER_SERVICE }],
          freqDroop: [
            { id: FREQ_DROOP_ID, isDefault: true, isSuperseded: false, freqDroop: FREQ_DROOP },
          ],
        });
        pushSendAckStep(steps, 13, 'Send ReportDERControlRequest (enterService, freqDroop)', resp);
      } catch (err) {
        steps.push({
          step: 13,
          description: 'Send ReportDERControlRequest (enterService, freqDroop)',
          status: 'failed',
          expected: 'ReportDERControlResponse',
          actual: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await triggerAndCheck(
      15,
      'GetDERControl',
      { requestId: 2, isDefault: false },
      'isDefault false',
      equals('isDefault', false),
    );
    const report2 = received.filter((r) => r.action === 'GetDERControl').at(-1);
    if (report2 != null && report2 !== report1) {
      try {
        const resp = await ctx.client.sendCall('ReportDERControl', {
          requestId: report2.payload['requestId'],
          curve: [
            {
              id: FREQ_WATT_ID,
              curveType: 'FreqWatt',
              isDefault: false,
              isSuperseded: false,
              curve: {
                priority: 4,
                yUnit: 'PctMaxW',
                curveData: FREQ_WATT_CURVE_DATA,
                startTime,
                duration: 900,
              },
            },
          ],
        });
        pushSendAckStep(steps, 17, 'Send ReportDERControlRequest (FreqWatt curve)', resp);
      } catch (err) {
        steps.push({
          step: 17,
          description: 'Send ReportDERControlRequest (FreqWatt curve)',
          status: 'failed',
          expected: 'ReportDERControlResponse',
          actual: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The doc's manual action asks for controlType LimitMaxDischarge while its step 19
    // validation names VoltVar. The test triggers the manual action and checks the CSMS
    // forwards that controlType.
    await triggerAndCheck(
      19,
      'GetDERControl',
      { requestId: 3, controlType: 'LimitMaxDischarge' },
      'controlType LimitMaxDischarge',
      equals('controlType', 'LimitMaxDischarge'),
    );
    await triggerAndCheck(
      21,
      'GetDERControl',
      { requestId: 4, controlId: FREQ_WATT_ID },
      'controlId present',
      (p) => (p['controlId'] != null ? null : 'controlId omitted'),
    );

    // Step 23: the scheduled FreqWatt control starts and supersedes the EnterService control.
    try {
      const resp = await ctx.client.sendCall('NotifyDERStartStop', {
        controlId: FREQ_WATT_ID,
        started: true,
        timestamp: new Date().toISOString(),
        supersededIds: [ENTER_SERVICE_ID],
      });
      pushSendAckStep(steps, 23, 'Send NotifyDERStartStopRequest', resp);
    } catch (err) {
      steps.push({
        step: 23,
        description: 'Send NotifyDERStartStopRequest',
        status: 'failed',
        expected: 'NotifyDERStartStopResponse',
        actual: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
