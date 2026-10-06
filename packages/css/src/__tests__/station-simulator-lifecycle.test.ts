// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeHarness,
  priv,
  silenceConsole,
  stubSql,
  type CallResponder,
  type Harness,
  type Protocol,
} from './sim-harness.js';

// A station whose css_transactions reads follow its in-memory transactions,
// as the real table would after createTransaction / completeTransaction.
async function liveHarness(protocol: Protocol, respond?: CallResponder): Promise<Harness> {
  let ref: Harness | null = null;
  const sql = stubSql((q, values) => {
    if (ref == null || !q.includes('SELECT transaction_id, meter_start_wh, id_token')) {
      return undefined;
    }
    const evseId = values[1] as number;
    const txId = (priv(ref, 'activeTransactionIds') as Map<number, string>).get(evseId);
    if (txId == null) return [];
    const ctx = (priv(ref, 'evseContexts') as Map<number, { authorizedToken: string | null }>).get(
      evseId,
    );
    return [{ transaction_id: txId, meter_start_wh: 0, id_token: ctx?.authorizedToken ?? '' }];
  });
  const h = await makeHarness({ protocol, sql, boot: true, ...(respond ? { respond } : {}) });
  ref = h;
  h.sendCall.mockClear();
  return h;
}

function ctxOf(h: Harness, evseId = 1): Record<string, unknown> {
  return (priv(h, 'evseContexts') as Map<number, Record<string, unknown>>).get(evseId) ?? {};
}

function statusOf(h: Harness, evseId = 1): string | undefined {
  return (priv(h, 'evseConnectorStatus') as Map<number, string>).get(evseId);
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('boot (B01)', () => {
  it('2.1: BootNotification PowerUp, then every connector Available', async () => {
    const h = await makeHarness({ boot: true });
    expect(h.sent('BootNotification')[0]).toMatchObject({
      reason: 'PowerUp',
      chargingStation: { vendorName: 'V', model: 'M', serialNumber: 'SN', firmwareVersion: '1.0' },
    });
    expect(h.sent('StatusNotification')).toContainEqual(
      expect.objectContaining({ evseId: 1, connectorId: 1, connectorStatus: 'Available' }),
    );
    expect(h.sent('SecurityEventNotification')[0]?.['type']).toBe('StartupOfTheDevice');
    expect(statusOf(h)).toBe('Available');
  });

  it('1.6: BootNotification with charge point fields and connector 0 status', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6', boot: true });
    expect(h.sent('BootNotification')[0]).toMatchObject({
      chargePointVendor: 'V',
      chargePointModel: 'M',
      chargePointSerialNumber: 'SN',
    });
    const statuses = h.sent('StatusNotification');
    expect(statuses).toContainEqual({ connectorId: 0, errorCode: 'NoError', status: 'Available' });
    expect(statuses).toContainEqual({ connectorId: 1, errorCode: 'NoError', status: 'Available' });
  });

  it('a Pending boot sends no connector status', async () => {
    const h = await makeHarness({
      boot: true,
      respond: (action) =>
        action === 'BootNotification'
          ? { status: 'Pending', interval: 30, currentTime: new Date().toISOString() }
          : undefined,
    });
    expect(h.sent('BootNotification')).toHaveLength(1);
    expect(h.sent('StatusNotification')).toHaveLength(0);
  });
});

describe('charging session OCPP 2.1', () => {
  it('plug in, authorize, start, meter values, stop, unplug', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    expect(statusOf(h)).toBe('Occupied');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Occupied' });

    const txId = await h.sim.startCharging(1, 'TAG-1', 'ISO14443');
    expect(txId).toEqual(expect.any(String));
    expect(h.sent('Authorize')[0]).toMatchObject({
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
    });
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started).toMatchObject({
      evse: { id: 1, connectorId: 1 },
      transactionInfo: { transactionId: txId },
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
    });
    expect(ctxOf(h)['transactionId']).toBe(txId);

    // Starting again with the same token returns the running transaction.
    expect(await h.sim.startCharging(1, 'TAG-1')).toBe(txId);
    await expect(h.sim.startCharging(1, 'OTHER')).rejects.toThrow('already active');

    await vi.advanceTimersByTimeAsync(35_000);
    const updated = h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Updated');
    expect(updated.length).toBeGreaterThan(0);
    const periodic = updated.find((e) => e['triggerReason'] === 'MeterValuePeriodic');
    expect(periodic?.['meterValue']).toBeDefined();

    await h.sim.stopCharging(1, 'Local');
    const ended = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Ended');
    expect(ended).toMatchObject({
      triggerReason: 'StopAuthorized',
      transactionInfo: { transactionId: txId, stoppedReason: 'Local' },
    });
    const seqNos = h.sent('TransactionEvent').map((e) => e['seqNo'] as number);
    expect(seqNos).toEqual([...seqNos].sort((a, b) => a - b));
    expect(ctxOf(h)['transactionId']).toBeNull();

    const before = h.sent('TransactionEvent').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent('TransactionEvent')).toHaveLength(before);

    await h.sim.unplug(1);
    expect(statusOf(h)).toBe('Available');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
  });

  it('a rejected Authorize does not start a transaction', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Authorize' ? { idTokenInfo: { status: 'Blocked' } } : undefined,
    );
    await h.sim.plugIn(1);
    await expect(h.sim.startCharging(1, 'BAD')).rejects.toThrow('Blocked');
    expect(h.sent('TransactionEvent').filter((e) => e['eventType'] === 'Started')).toHaveLength(0);
  });

  it('remote start before plug in waits for the cable, then starts with RemoteStart', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('AuthCtrlr.AuthorizeRemoteStart', 'false');
    const res = await h.invoke('RequestStartTransaction', {
      idToken: { idToken: 'TAG-R', type: 'ISO14443' },
      remoteStartId: 55,
      evseId: 1,
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(ctxOf(h)['state']).toBe('Authorized');
    await h.sim.plugIn(1);
    const started = h.sent('TransactionEvent').find((e) => e['eventType'] === 'Started');
    expect(started).toMatchObject({
      triggerReason: 'RemoteStart',
      transactionInfo: { remoteStartId: 55 },
    });
    const stop = await h.invoke('RequestStopTransaction', {
      transactionId: (started?.['transactionInfo'] as { transactionId: string }).transactionId,
    });
    expect(stop).toEqual({ status: 'Accepted' });
    expect(h.sent('TransactionEvent').at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'RemoteStop',
    });
  });

  it('remote start on a plugged EVSE starts at once and returns the transaction id', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const res = await h.invoke('RequestStartTransaction', {
      idToken: { idToken: 'TAG-R', type: 'ISO14443' },
      remoteStartId: 3,
      evseId: 1,
    });
    expect(res['status']).toBe('Accepted');
    expect(res['transactionId']).toBe(ctxOf(h)['transactionId']);
    expect(
      await h.invoke('RequestStartTransaction', {
        idToken: { idToken: 'TAG-R', type: 'ISO14443' },
        remoteStartId: 4,
        evseId: 1,
      }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'TxInProgress' } });
  });

  it('remote start is rejected on an EVSE reserved for another token', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.invoke('ReserveNow', {
      id: 1,
      evseId: 1,
      idToken: { idToken: 'OWNER', type: 'ISO14443' },
      expiryDateTime: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(
      await h.invoke('RequestStartTransaction', {
        idToken: { idToken: 'SOMEONE', type: 'ISO14443' },
        remoteStartId: 1,
        evseId: 1,
      }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'ReservedForOtherToken' } });
  });

  it('RequestStopTransaction for an unknown transaction is rejected', async () => {
    const h = await liveHarness('ocpp2.1');
    expect(await h.invoke('RequestStopTransaction', { transactionId: 'nope' })).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'UnknownTransaction' },
    });
  });

  it('TriggerMessage TransactionEvent reports the running transaction with trigger Trigger', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    expect(await h.invoke('TriggerMessage', { requestedMessage: 'TransactionEvent' })).toEqual({
      status: 'Accepted',
    });
    await vi.advanceTimersByTimeAsync(100);
    const triggered = h.sent('TransactionEvent').find((e) => e['triggerReason'] === 'Trigger');
    expect(triggered).toMatchObject({
      eventType: 'Updated',
      transactionInfo: { transactionId: txId },
    });
    expect(triggered?.['meterValue']).toBeDefined();
  });

  it('UnlockConnector refuses during a transaction and unlocks an idle connector', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    expect(await h.invoke('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'OngoingAuthorizedTransaction',
    });
    await h.sim.stopCharging(1);
    expect(await h.invoke('UnlockConnector', { evseId: 1, connectorId: 2 })).toEqual({
      status: 'UnknownConnector',
    });
    expect(await h.invoke('UnlockConnector', { evseId: 7, connectorId: 1 })).toEqual({
      status: 'UnknownConnector',
    });
    expect(await h.invoke('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'Unlocked',
    });
    expect(ctxOf(h)['cablePlugged']).toBe(false);
    expect(statusOf(h)).toBe('Available');
  });

  it('Reset OnIdle with a running transaction is Scheduled; Immediate stops it and reboots', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    expect(await h.invoke('Reset', { type: 'OnIdle' })).toEqual({
      status: 'Scheduled',
      statusInfo: { reasonCode: 'TransactionInProgress' },
    });
    expect(await h.invoke('Reset', { type: 'Immediate' })).toEqual({ status: 'Accepted' });
    expect(h.sent('TransactionEvent').at(-1)).toMatchObject({
      eventType: 'Ended',
      transactionInfo: { transactionId: txId, stoppedReason: 'ImmediateReset' },
    });
    await vi.advanceTimersByTimeAsync(600);
    const boots = h.sent('BootNotification');
    expect(boots.at(-1)?.['reason']).toBe('RemoteReset');
    expect(statusOf(h)).toBe('Available');
  });

  it('Reset ImmediateAndResume is rejected without a ResumptionTimeout', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.ResumptionTimeout', '0');
    expect(await h.invoke('Reset', { type: 'ImmediateAndResume' })).toEqual({
      status: 'Rejected',
    });
  });
});

describe('charging session OCPP 1.6', () => {
  it('plug in, start, meter values, stop, unplug', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    expect(h.sent('StatusNotification').at(-1)).toEqual({
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Preparing',
    });
    const txId = await h.sim.startCharging(1, 'TAG-16');
    expect(h.sent('Authorize')[0]).toEqual({ idTag: 'TAG-16' });
    expect(h.sent('StartTransaction')[0]).toMatchObject({ connectorId: 1, idTag: 'TAG-16' });
    expect(txId).toBe('4242');
    expect(h.sent('StatusNotification').at(-1)?.['status']).toBe('Charging');

    await vi.advanceTimersByTimeAsync(65_000);
    const meter = h.sent('MeterValues');
    expect(meter.length).toBeGreaterThan(0);
    expect(meter[0]).toMatchObject({ connectorId: 1, transactionId: 4242 });

    await h.sim.stopCharging(1, 'Local');
    expect(h.sent('StopTransaction')[0]).toMatchObject({
      transactionId: 4242,
      idTag: 'TAG-16',
      reason: 'Local',
    });
    await h.sim.unplug(1);
    expect(h.sent('StatusNotification').at(-1)?.['status']).toBe('Available');
  });

  it('RemoteStartTransaction before plug in moves to Preparing and starts on plug in', async () => {
    const h = await liveHarness('ocpp1.6');
    expect(
      await h.invoke('RemoteStartTransaction', {
        idTag: 'R1',
        connectorId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toEqual({ status: 'Rejected' });
    expect(await h.invoke('RemoteStartTransaction', { idTag: 'R1', connectorId: 9 })).toEqual({
      status: 'Rejected',
    });
    expect(await h.invoke('RemoteStartTransaction', { idTag: 'R1', connectorId: 1 })).toEqual({
      status: 'Accepted',
    });
    expect(statusOf(h)).toBe('Preparing');
    await h.sim.plugIn(1);
    expect(h.sent('StartTransaction')[0]).toMatchObject({ connectorId: 1, idTag: 'R1' });
    expect(await h.invoke('RemoteStartTransaction', { idTag: 'R1', connectorId: 1 })).toEqual({
      status: 'Rejected',
    });
    expect(await h.invoke('RemoteStopTransaction', { transactionId: 1 })).toEqual({
      status: 'Rejected',
    });
    expect(await h.invoke('RemoteStopTransaction', { transactionId: 4242 })).toEqual({
      status: 'Accepted',
    });
    expect(h.sent('StopTransaction')[0]).toMatchObject({ transactionId: 4242, reason: 'Remote' });
  });

  it('ConnectionTimeOut deauthorizes a remote start when no cable arrives', async () => {
    const h = await liveHarness('ocpp1.6');
    h.sim.setConfigValue('ConnectionTimeOut', '30');
    await h.invoke('RemoteStartTransaction', { idTag: 'R1', connectorId: 1 });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ctxOf(h)['authorizedToken']).toBeNull();
    expect(statusOf(h)).toBe('Available');
    expect(h.sent('StartTransaction')).toHaveLength(0);
  });

  it('Soft reset stops the transaction with SoftReset; Hard reset reconnects', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG');
    expect(await h.invoke('Reset', { type: 'Soft' })).toEqual({ status: 'Accepted' });
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'SoftReset' });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.sim.client.reconnectNow).toHaveBeenCalled();
  });

  it('UnlockConnector stops a running 1.6 transaction with UnlockCommand', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG');
    expect(await h.invoke('UnlockConnector', { connectorId: 1 })).toEqual({ status: 'Unlocked' });
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'UnlockCommand' });
    expect(await h.invoke('UnlockConnector', { connectorId: 3 })).toEqual({
      status: 'NotSupported',
    });
  });

  it('TriggerMessage validates the requested message and connector', async () => {
    const h = await liveHarness('ocpp1.6');
    expect(await h.invoke('TriggerMessage', { requestedMessage: 'LogStatusNotification' })).toEqual(
      { status: 'NotImplemented' },
    );
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 5 }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 1 }),
    ).toEqual({ status: 'Accepted' });
    expect(await h.invoke('TriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'Accepted',
    });
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }),
    ).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent('StatusNotification').at(-1)).toEqual({
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    expect(h.sent('Heartbeat')).toHaveLength(1);
    expect(h.sent('DiagnosticsStatusNotification')).toEqual([{ status: 'Idle' }]);
    const mv = h.sent('MeterValues').at(-1);
    const sampled = (
      mv?.['meterValue'] as Array<{ sampledValue: Array<Record<string, unknown>> }>
    )[0]?.sampledValue;
    expect(sampled?.every((s) => s['context'] === 'Trigger')).toBe(true);
  });
});

describe('TriggerMessage OCPP 2.1', () => {
  it('rejects a BootNotification trigger after an accepted boot and unknown custom triggers', async () => {
    const h = await liveHarness('ocpp2.1');
    expect(await h.invoke('TriggerMessage', { requestedMessage: 'BootNotification' })).toEqual({
      status: 'Rejected',
    });
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'CustomTrigger', customTrigger: 'X' }),
    ).toEqual({ status: 'NotImplemented' });
    expect(
      await h.invoke('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' }),
    ).toEqual({ status: 'NotImplemented' });
  });

  it('sends the triggered status, log, firmware and custom messages', async () => {
    const h = await liveHarness('ocpp2.1');
    for (const requestedMessage of [
      'FirmwareStatusNotification',
      'LogStatusNotification',
      'PublishFirmwareStatusNotification',
    ]) {
      expect(await h.invoke('TriggerMessage', { requestedMessage })).toEqual({
        status: 'Accepted',
      });
    }
    expect(
      await h.invoke('TriggerMessage', {
        requestedMessage: 'CustomTrigger',
        customTrigger: 'DiagnosticsLog',
      }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await h.invoke('TriggerMessage', {
        requestedMessage: 'StatusNotification',
        evse: { id: 1, connectorId: 1 },
      }),
    ).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent('FirmwareStatusNotification')).toEqual([{ status: 'Idle', requestId: 0 }]);
    expect(h.sent('LogStatusNotification')).toEqual([{ status: 'Idle', requestId: 0 }]);
    expect(h.sent('PublishFirmwareStatusNotification')[0]).toMatchObject({ status: 'Idle' });
    expect(h.sent('Heartbeat')).toHaveLength(1);
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Available',
    });
  });
});
