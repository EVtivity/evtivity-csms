// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import { makeHarness, priv, silenceConsole } from './sim-harness.js';

// The variables of the four data plan templates (migration 0479): every push
// to the simulator is Accepted.
const TEMPLATE_2X = [
  ['OCPPCommCtrlr', 'WebSocketPingInterval', null, '240'],
  ['OCPPCommCtrlr', 'QueueAllMessages', null, 'true'],
  ['OCPPCommCtrlr', 'OfflineThreshold', null, '300'],
  ['OCPPCommCtrlr', 'RetryBackOffWaitMinimum', null, '15'],
  ['OCPPCommCtrlr', 'RetryBackOffRandomRange', null, '30'],
  ['OCPPCommCtrlr', 'RetryBackOffRepeatTimes', null, '5'],
  ['SampledDataCtrlr', 'TxStartedMeasurands', null, 'Energy.Active.Import.Register'],
  ['SampledDataCtrlr', 'TxEndedInterval', null, '0'],
  ['SampledDataCtrlr', 'RegisterValuesWithoutPhases', null, 'true'],
  ['AlignedDataCtrlr', 'SendDuringIdle', null, 'true'],
  ['AlignedDataCtrlr', 'TxEndedInterval', null, '0'],
  ['OCPPCommCtrlr', 'MessageTimeout', 'Default', '60'],
  ['OCPPCommCtrlr', 'MessageAttempts', 'TransactionEvent', '5'],
  ['OCPPCommCtrlr', 'MessageAttemptInterval', 'TransactionEvent', '120'],
] as const;

const TEMPLATE_16 = [
  ['WebSocketPingInterval', '240'],
  ['TransactionMessageAttempts', '5'],
  ['TransactionMessageRetryInterval', '120'],
] as const;

beforeEach(() => {
  silenceConsole();
});

describe('data plan templates on the simulator', () => {
  for (const protocol of ['ocpp2.1', 'ocpp2.0.1'] as const) {
    it(`accepts every variable of the 2.x templates (${protocol})`, async () => {
      const h = await makeHarness({ protocol });
      const res = await h.invoke('SetVariables', {
        setVariableData: TEMPLATE_2X.map(([component, variable, instance, value]) => ({
          component: { name: component },
          variable: instance == null ? { name: variable } : { name: variable, instance },
          attributeValue: value,
        })),
      });
      const statuses = (res['setVariableResult'] as { attributeStatus: string }[]).map(
        (r) => r.attributeStatus,
      );
      expect(statuses).toEqual(TEMPLATE_2X.map(() => 'Accepted'));
      const cfg = priv(h, 'configVariables') as Map<string, { value: string }>;
      expect(cfg.get('OCPPCommCtrlr.MessageTimeout#Default')?.value).toBe('60');
      expect(cfg.get('OCPPCommCtrlr.MessageAttempts#TransactionEvent')?.value).toBe('5');
    });
  }

  it('accepts every key of the 1.6 templates', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    for (const [key, value] of TEMPLATE_16) {
      const res = await h.invoke('ChangeConfiguration', { key, value });
      expect(res['status']).toBe('Accepted');
    }
  });
});

describe('idle reading interval 0', () => {
  it('stops the clock-aligned timer and sends no idle reading (2.x)', async () => {
    const h = await makeHarness({ protocol: 'ocpp2.1' });
    h.sim.startClockAlignedTimer();
    expect(priv(h, 'clockAlignedTimer')).not.toBeNull();
    const res = await h.invoke('SetVariables', {
      setVariableData: [
        {
          component: { name: 'AlignedDataCtrlr' },
          variable: { name: 'Interval' },
          attributeValue: '0',
        },
      ],
    });
    expect((res['setVariableResult'] as { attributeStatus: string }[])[0]?.attributeStatus).toBe(
      'Accepted',
    );
    expect(priv(h, 'clockAlignedTimer')).toBeNull();
    await h.sim.sendClockAlignedMeterValues();
    expect(h.sent('MeterValues')).toHaveLength(0);
  });

  it('stops the clock-aligned timer for ClockAlignedDataInterval 0 (1.6)', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sim.startClockAlignedTimer();
    const res = await h.invoke('ChangeConfiguration', {
      key: 'ClockAlignedDataInterval',
      value: '0',
    });
    expect(res['status']).toBe('Accepted');
    expect(priv(h, 'clockAlignedTimer')).toBeNull();
    await h.sim.sendClockAlignedMeterValues();
    expect(h.sent('MeterValues')).toHaveLength(0);
  });
});
