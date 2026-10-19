// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { CommandDispatcher } from '../server/command-dispatcher.js';
import { Ocpp201CommandError } from '../server/ocpp201/to-ocpp201.js';
import { ActionRegistry as Registry201 } from '../generated/v2_0_1/registry.js';

const logger = pino({ level: 'silent' });

function connection(protocol: string) {
  return { ws: {}, session: { stationId: 'CS-201', ocppProtocol: protocol } };
}

const displayMessage = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  message: {
    id: 1,
    priority: 'NormalCycle',
    message: { format: 'UTF8', content: 'Hello' },
    ...extra,
  },
});

describe('CommandDispatcher to an OCPP 2.0.1 station', () => {
  let correlator: { sendCall: ReturnType<typeof vi.fn> };
  let dispatcher: CommandDispatcher;

  beforeEach(() => {
    correlator = { sendCall: vi.fn().mockResolvedValue({ status: 'Accepted' }) };
    dispatcher = new CommandDispatcher(
      { get: vi.fn().mockReturnValue(connection('ocpp2.0.1')) } as never,
      correlator as never,
      logger,
    );
  });

  it('fits a translated command and sends only what the 2.0.1 schema allows', async () => {
    await dispatcher.sendVersionAwareCommand(
      'CS-201',
      'SetDisplayMessage',
      displayMessage({ messageExtra: [{ format: 'UTF8', language: 'de', content: 'Hallo' }] }),
    );

    const [, , action, payload] = correlator.sendCall.mock.calls[0] as unknown[];
    expect(action).toBe('SetDisplayMessage');
    expect(payload).toEqual(displayMessage());
    expect(Registry201.SetDisplayMessage.validateRequest(payload)).toBe(true);
  });

  it('runs a ready-made payload through the same 2.0.1 check', async () => {
    await dispatcher.sendCommand('CS-201', 'SetVariables', {
      setVariableData: [
        {
          attributeValue: '60',
          component: { name: 'SampledDataCtrlr' },
          variable: { name: 'TxUpdatedInterval' },
        },
      ],
      customData: { vendorId: 'v' },
    });

    expect(correlator.sendCall).toHaveBeenCalledTimes(1);
  });

  it('refuses a ready-made 2.1-only payload before sending it', async () => {
    await expect(
      dispatcher.sendCommand(
        'CS-201',
        'SetDisplayMessage',
        displayMessage({ state: 'Discharging' }),
      ),
    ).rejects.toThrow(/message\.state Discharging is not defined in OCPP 2\.0\.1/);
    await expect(
      dispatcher.sendCommand('CS-201', 'SetVariableMonitoring', {
        setMonitoringData: [
          {
            value: 1,
            type: 'Delta',
            severity: 5,
            component: { name: 'EVSE' },
            variable: { name: 'Power' },
            periodicEventStream: { interval: 10 },
          },
        ],
      }),
    ).rejects.toThrow(/periodicEventStream/);
    expect(correlator.sendCall).not.toHaveBeenCalled();
  });

  it('refuses a 2.1-only action on both paths before sending it', async () => {
    await expect(
      dispatcher.sendVersionAwareCommand('CS-201', 'SetDefaultTariff', { evseId: 0 }),
    ).rejects.toThrow(
      new Ocpp201CommandError('SetDefaultTariff', 'the action is defined in OCPP 2.1 only'),
    );
    await expect(
      dispatcher.sendCommand('CS-201', 'ChangeTransactionTariff', { transactionId: 'T1' }),
    ).rejects.toBeInstanceOf(Ocpp201CommandError);
    await expect(
      dispatcher.sendCommand('CS-201', 'TriggerMessage', {
        requestedMessage: 'SignV2G20Certificate',
      }),
    ).rejects.toThrow(/SignV2G20Certificate/);
    expect(correlator.sendCall).not.toHaveBeenCalled();
  });

  it('sends a 2.1 station a ready-made payload unchanged', async () => {
    dispatcher = new CommandDispatcher(
      { get: vi.fn().mockReturnValue(connection('ocpp2.1')) } as never,
      correlator as never,
      logger,
    );
    const payload = displayMessage({ state: 'Discharging' });

    await dispatcher.sendCommand('CS-21', 'SetDisplayMessage', payload);

    expect(correlator.sendCall.mock.calls[0]?.[3]).toBe(payload);
  });
});
