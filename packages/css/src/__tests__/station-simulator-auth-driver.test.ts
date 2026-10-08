// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  call,
  defaultResponse,
  liveHarness,
  makeHarness,
  priv,
  silenceConsole,
  type Harness,
  type Protocol,
} from './sim-harness.js';

function ctxOf(h: Harness, evseId = 1): Record<string, unknown> {
  return (priv(h, 'evseContexts') as Map<number, Record<string, unknown>>).get(evseId) ?? {};
}

function statusOf(h: Harness, evseId = 1): string | undefined {
  return (priv(h, 'evseConnectorStatus') as Map<number, string>).get(evseId);
}

function setOnline(h: Harness, online: boolean): void {
  (h.sim.client as unknown as { isConnected: boolean }).isConnected = online;
}

function queue(h: Harness): Array<{ action: string; payload: Record<string, unknown> }> {
  return priv(h, 'offlineMessageQueue') as Array<{
    action: string;
    payload: Record<string, unknown>;
  }>;
}

function groupMap(h: Harness): Map<string, Record<string, unknown>> {
  return priv(h, 'tokenGroupMap') as Map<string, Record<string, unknown>>;
}

function authCache(h: Harness): { set(k: string, v: unknown): void; get(k: string): unknown } {
  return priv(h, 'authCache') as { set(k: string, v: unknown): void; get(k: string): unknown };
}

function txEvents(h: Harness, type?: string): Array<Record<string, unknown>> {
  return h.sent('TransactionEvent').filter((e) => type == null || e['eventType'] === type);
}

function infoOf(e: Record<string, unknown> | undefined): Record<string, unknown> {
  return (e?.['transactionInfo'] as Record<string, unknown> | undefined) ?? {};
}

const inOneHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('authorize with AuthCtrlr.DisableRemoteAuthorization (2.1)', () => {
  it('answers from the local list, then the cache, then Unknown, without contacting the CSMS', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('AuthCtrlr.DisableRemoteAuthorization', 'true');
    h.sim.addToLocalAuthList('LOCAL', 'Blocked');
    h.sim.addToAuthCache('CACHED', 'Accepted');

    expect(await h.sim.authorize(1, 'LOCAL')).toEqual({ idTokenInfo: { status: 'Blocked' } });
    expect(await h.sim.authorize(1, 'CACHED')).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(await h.sim.authorize(1, 'NOPE')).toEqual({ idTokenInfo: { status: 'Unknown' } });
    expect(h.sent('Authorize')).toHaveLength(0);
  });

  it('drops an expired cache entry and answers Unknown (C10.FR.13)', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('AuthCtrlr.DisableRemoteAuthorization', 'true');
    authCache(h).set('OLD', {
      status: 'Accepted',
      cacheExpiryDateTime: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await h.sim.authorize(1, 'OLD')).toEqual({ idTokenInfo: { status: 'Unknown' } });
    expect(authCache(h).get('OLD')).toBeUndefined();
  });
});

describe('authorize stop rules', () => {
  it('2.1: a token of the same group stops the transaction (C09 GroupId)', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Authorize'
        ? { idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G', type: 'Central' } } }
        : undefined,
    );
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-A');
    expect(groupMap(h).get('TAG-A')).toEqual({ idToken: 'G', type: 'Central' });

    await h.sim.authorize(1, 'TAG-B');
    const ended = txEvents(h, 'Ended')[0];
    expect(infoOf(ended)).toMatchObject({ transactionId: txId, stoppedReason: 'Local' });
    expect(ended?.['triggerReason']).toBe('StopAuthorized');
    expect(ctxOf(h)['transactionId']).toBeNull();
  });

  it('2.1: a group stored for the token (no group in the reply) also stops it', async () => {
    let withGroup = true;
    const h = await liveHarness('ocpp2.1', (action) => {
      if (action !== 'Authorize') return undefined;
      return withGroup
        ? { idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G', type: 'Central' } } }
        : { idTokenInfo: { status: 'Accepted' } };
    });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-A');
    withGroup = false;
    h.sim.addToLocalAuthList('TAG-B', 'Accepted', { idToken: 'G', type: 'Central' });
    await h.sim.authorize(1, 'TAG-B');
    expect(txEvents(h, 'Ended')).toHaveLength(1);
  });

  it('2.1: a token of a different group does not stop the transaction', async () => {
    const h = await liveHarness('ocpp2.1', (action, payload) => {
      if (action !== 'Authorize') return undefined;
      const tok = (payload['idToken'] as Record<string, unknown>)['idToken'];
      const group = tok === 'TAG-A' ? 'G1' : 'G2';
      return {
        idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: group, type: 'Central' } },
      };
    });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-A');
    await h.sim.authorize(1, 'TAG-B');
    expect(txEvents(h, 'Ended')).toHaveLength(0);
    expect(ctxOf(h)['transactionId']).not.toBeNull();
  });

  it('2.1: the MasterPass group stops every running transaction', async () => {
    const h = await liveHarness('ocpp2.1', (action, payload) => {
      if (action !== 'Authorize') return undefined;
      const tok = (payload['idToken'] as Record<string, unknown>)['idToken'];
      return tok === 'MASTER'
        ? { idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'MP', type: 'Central' } } }
        : { idTokenInfo: { status: 'Accepted' } };
    });
    h.sim.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MP');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-A');
    const res = await h.sim.authorize(1, 'MASTER');
    expect(res['idTokenInfo']).toMatchObject({ status: 'Accepted' });
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('StopAuthorized');
    expect(infoOf(ended)).toMatchObject({ transactionId: txId, stoppedReason: 'MasterPass' });
  });

  it('2.1: the start token stops its own transaction', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    await h.sim.authorize(1, 'TAG-1');
    expect(infoOf(txEvents(h, 'Ended')[0])).toMatchObject({
      transactionId: txId,
      stoppedReason: 'Local',
    });
  });

  it('1.6: a token with the same parentIdTag stops the transaction', async () => {
    const h = await liveHarness('ocpp1.6', (action) =>
      action === 'Authorize' ? { idTagInfo: { status: 'Accepted', parentIdTag: 'P' } } : undefined,
    );
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-A');
    expect(groupMap(h).get('TAG-A')).toEqual({ idToken: 'P', type: 'ISO14443' });
    await h.sim.authorize(1, 'TAG-B');
    expect(h.sent('StopTransaction')[0]).toMatchObject({ transactionId: 4242, reason: 'Local' });
  });

  it('1.6: an unrelated token does not stop the transaction', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-A');
    await h.sim.authorize(1, 'TAG-B');
    expect(h.sent('StopTransaction')).toHaveLength(0);
  });
});

describe('authorize starts or prepares a session', () => {
  it('2.1: consumes a matching reservation and reports the connector Available', async () => {
    const h = await makeHarness();
    await h.invoke('ReserveNow', {
      id: 7,
      evseId: 1,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      expiryDateTime: inOneHour(),
    });
    expect(statusOf(h)).toBe('Reserved');
    await h.sim.authorize(1, 'TAG-1');
    await vi.advanceTimersByTimeAsync(0);
    expect((priv(h, 'reservations') as Map<number, unknown>).size).toBe(0);
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
  });

  it('2.1: a reservation for the group token is consumed by that group', async () => {
    const h = await makeHarness();
    await h.invoke('ReserveNow', {
      id: 8,
      evseId: 1,
      idToken: { idToken: 'OTHER', type: 'ISO14443' },
      groupIdToken: { idToken: 'GRP', type: 'Central' },
      expiryDateTime: inOneHour(),
    });
    await h.sim.authorize(1, 'GRP');
    expect((priv(h, 'reservations') as Map<number, unknown>).size).toBe(0);
  });

  it('2.1: records the driver language from language1 (O01)', async () => {
    const h = await makeHarness({
      respond: (action) =>
        action === 'Authorize'
          ? { idTokenInfo: { status: 'Accepted', language1: 'de' } }
          : undefined,
    });
    await h.sim.authorize(1, 'TAG-1');
    expect((priv(h, 'evseDriverLanguage') as Map<number, string>).get(1)).toBe('de');
  });

  it('2.1: with the cable connected it starts the transaction at once', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.authorize(1, 'TAG-1');
    const started = txEvents(h, 'Started')[0];
    expect(started).toMatchObject({ triggerReason: 'Authorized' });
    expect(ctxOf(h)['transactionId']).toBe(infoOf(started)['transactionId']);
  });

  it('2.1: without a cable it waits Authorized and drops the authorization after EVConnectionTimeOut', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('TxCtrlr.EVConnectionTimeOut', '20');
    await h.sim.authorize(1, 'TAG-1');
    expect(ctxOf(h)['state']).toBe('Authorized');
    expect(ctxOf(h)['authorizedToken']).toBe('TAG-1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctxOf(h)['state']).toBe('Available');
    expect(ctxOf(h)['authorizedToken']).toBeNull();
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ connectorStatus: 'Available' });
    expect(txEvents(h)).toHaveLength(0);
  });

  it('1.6: with the connector Preparing it starts the transaction', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.authorize(1, 'TAG-1');
    expect(h.sent('StartTransaction')[0]).toMatchObject({ connectorId: 1, idTag: 'TAG-1' });
  });

  it('1.6: without a cable it reports Preparing and reverts after ConnectionTimeOut', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.sim.setConfigValue('ConnectionTimeOut', '15');
    await h.sim.authorize(1, 'TAG-1');
    expect(ctxOf(h)['state']).toBe('Authorized');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({
      connectorId: 1,
      status: 'Preparing',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ctxOf(h)['state']).toBe('Available');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ status: 'Available' });
  });

  it('returns a rejected result without storing the authorization', async () => {
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      respond: (action) =>
        action === 'Authorize' ? { idTagInfo: { status: 'Invalid' } } : undefined,
    });
    const res = await h.sim.authorize(1, 'BAD');
    expect(res).toEqual({ idTagInfo: { status: 'Invalid' } });
    expect(ctxOf(h)['authorizedToken']).toBeNull();
  });
});

describe('sendAuthorize local decisions', () => {
  it.each<[Protocol, string, string]>([
    ['ocpp2.1', 'AuthCtrlr.LocalPreAuthorize', 'idTokenInfo'],
    ['ocpp1.6', 'LocalPreAuthorize', 'idTagInfo'],
  ])(
    '%s local pre-authorize uses the list, then an Accepted cache entry',
    async (protocol, key, field) => {
      const h = await makeHarness({ protocol });
      h.sim.setConfigValue(key, 'true');
      h.sim.addToLocalAuthList('L', 'Blocked');
      h.sim.addToAuthCache('C', 'Accepted');
      h.sim.addToAuthCache('X', 'Blocked');
      expect(await h.sim.sendAuthorize('L')).toEqual({ [field]: { status: 'Blocked' } });
      expect(await h.sim.sendAuthorize('C')).toEqual({ [field]: { status: 'Accepted' } });
      expect(h.sent('Authorize')).toHaveLength(0);
      // A non-Accepted cache entry goes to the CSMS.
      await h.sim.sendAuthorize('X');
      expect(h.sent('Authorize')).toHaveLength(1);
    },
  );

  it('2.1: LocalAuthListCtrlr.DisablePostAuthorize answers from the list', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('LocalAuthListCtrlr.DisablePostAuthorize', 'true');
    h.sim.addToLocalAuthList('L', 'Expired');
    expect(await h.sim.sendAuthorize('L')).toEqual({ idTokenInfo: { status: 'Expired' } });
    await h.sim.sendAuthorize('OTHER');
    expect(h.sent('Authorize')).toHaveLength(1);
  });

  it('2.1: AuthCacheCtrlr.DisablePostAuthorize answers from the cache with any status', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'true');
    h.sim.addToAuthCache('C', 'Blocked');
    expect(await h.sim.sendAuthorize('C')).toEqual({ idTokenInfo: { status: 'Blocked' } });
    expect(h.sent('Authorize')).toHaveLength(0);
  });

  it.each<[Protocol, string]>([
    ['ocpp2.1', 'idTokenInfo'],
    ['ocpp1.6', 'idTagInfo'],
  ])(
    '%s offline: list, cache, AllowOfflineTxForUnknownId, then Unknown',
    async (protocol, field) => {
      const h = await makeHarness({ protocol, connected: false });
      h.sim.addToLocalAuthList('L', 'Accepted');
      h.sim.addToAuthCache('C', 'Blocked');
      expect(await h.sim.sendAuthorize('L')).toEqual({ [field]: { status: 'Accepted' } });
      expect(await h.sim.sendAuthorize('C')).toEqual({ [field]: { status: 'Blocked' } });
      expect(await h.sim.sendAuthorize('U')).toEqual({ [field]: { status: 'Unknown' } });
      h.sim.setConfigValue('AllowOfflineTxForUnknownId', 'true');
      expect(await h.sim.sendAuthorize('U')).toEqual({ [field]: { status: 'Accepted' } });
      expect(h.sent('Authorize')).toHaveLength(0);
    },
  );

  it.each<[Protocol, string]>([
    ['ocpp2.1', 'idTokenInfo'],
    ['ocpp1.6', 'idTagInfo'],
  ])(
    '%s connection error: falls back to list and cache, else rethrows',
    async (protocol, field) => {
      const h = await makeHarness({
        protocol,
        respond: (action) => {
          if (action === 'Authorize') throw new Error('socket closed');
          return undefined;
        },
      });
      h.sim.addToLocalAuthList('L', 'Accepted');
      h.sim.addToAuthCache('C', 'Accepted');
      expect(await h.sim.sendAuthorize('L')).toEqual({ [field]: { status: 'Accepted' } });
      expect(await h.sim.sendAuthorize('C')).toEqual({ [field]: { status: 'Accepted' } });
      await expect(h.sim.sendAuthorize('U')).rejects.toThrow('socket closed');
    },
  );

  it('2.1: a driver tariff with TariffCostCtrlr disabled reports a problem and deauthorizes (I08.FR.31)', async () => {
    const h = await makeHarness({
      respond: (action) =>
        action === 'Authorize'
          ? { idTokenInfo: { status: 'Accepted' }, tariff: { tariffId: 'T1', currency: 'EUR' } }
          : undefined,
    });
    h.sim.setConfigValue('TariffCostCtrlr.Enabled', 'false');
    h.sim.setConfigValue('TariffCostCtrlr.DeauthorizeOnProblem', 'true');
    const res = await h.sim.sendAuthorize('TAG-1');
    expect(res['idTokenInfo']).toMatchObject({ status: 'Invalid' });
    const driverTariffs = priv(h, 'driverTariffs') as Map<number, { tariffId: string }>;
    expect(driverTariffs.get(0)?.tariffId).toBe('T1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('NotifyEvent')).toHaveLength(1);
  });

  it('2.1: a driver tariff is reported as tariffId on the transaction', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Authorize'
        ? { idTokenInfo: { status: 'Accepted' }, tariff: { tariffId: 'T9', currency: 'EUR' } }
        : undefined,
    );
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    expect(infoOf(txEvents(h, 'Started')[0])['tariffId']).toBe('T9');
  });
});

describe('local list storage', () => {
  it('2.1: SendLocalList stores the group of an entry', async () => {
    const h = await makeHarness();
    const res = await h.invoke('SendLocalList', {
      versionNumber: 1,
      updateType: 'Full',
      localAuthorizationList: [
        {
          idToken: { idToken: 'T', type: 'ISO14443' },
          idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G', type: 'Central' } },
        },
      ],
    });
    expect(res['status']).toBe('Accepted');
    expect(groupMap(h).get('T')).toEqual({ idToken: 'G', type: 'Central' });
  });

  it('1.6: SendLocalList stores the parentIdTag as the group', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const res = await h.invoke('SendLocalList', {
      listVersion: 1,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'T', idTagInfo: { status: 'Accepted', parentIdTag: 'P' } }],
    });
    expect(res['status']).toBe('Accepted');
    expect(groupMap(h).get('T')).toEqual({ idToken: 'P', type: 'ISO14443' });
  });

  it('addToAuthCache with a group registers the group', async () => {
    const h = await makeHarness();
    h.sim.addToAuthCache('T', 'Accepted', { idToken: 'G', type: 'Central' });
    expect(groupMap(h).get('T')).toEqual({ idToken: 'G', type: 'Central' });
    expect(authCache(h).get('T')).toEqual({
      status: 'Accepted',
      groupIdToken: { idToken: 'G', type: 'Central' },
    });
  });
});

describe('startCharging offline', () => {
  it('rejects a token the local list blocks', async () => {
    const h = await makeHarness({ connected: false });
    h.sim.addToLocalAuthList('L', 'Blocked');
    await expect(h.sim.startCharging(1, 'L')).rejects.toThrow('Authorization rejected: Blocked');
  });

  it('rejects an unknown token unless AllowOfflineTxForUnknownId', async () => {
    const h = await makeHarness({ connected: false });
    await expect(h.sim.startCharging(1, 'U')).rejects.toThrow('Authorization rejected: Unknown');
  });

  it('1.6: queues StartTransaction with the consumed reservation for replay', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('ReserveNow', {
      connectorId: 1,
      expiryDate: inOneHour(),
      idTag: 'C',
      reservationId: 31,
    });
    setOnline(h, false);
    h.sim.addToAuthCache('C', 'Accepted');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'C');
    expect(txId).toMatch(/^\d+$/);
    const start = queue(h).find((m) => m.action === 'StartTransaction');
    expect(start?.payload).toMatchObject({ connectorId: 1, idTag: 'C', reservationId: 31 });
    expect((priv(h, 'reservations') as Map<number, unknown>).size).toBe(0);
  });

  it('1.6: accepts an unknown token offline with AllowOfflineTxForUnknownId and queues the stop', async () => {
    const h = await liveHarness('ocpp1.6');
    setOnline(h, false);
    h.sim.setConfigValue('AllowOfflineTxForUnknownId', 'true');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'U');
    await h.sim.stopCharging(1, 'Local');
    const stop = queue(h).find((m) => m.action === 'StopTransaction');
    expect(stop?.payload).toMatchObject({
      transactionId: Number(txId),
      reason: 'Local',
      idTag: 'U',
    });
    expect(h.sent('StopTransaction')).toHaveLength(0);
  });

  it('trusts a reported plugged status after a restart', async () => {
    const h = await liveHarness('ocpp2.1');
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, 'Occupied');
    expect(ctxOf(h)['cablePlugged']).toBe(false);
    await h.sim.startCharging(1, 'TAG-1');
    expect(ctxOf(h)['cablePlugged']).toBe(true);
  });
});

describe('transaction start details (2.1)', () => {
  it('reports the web payment limits once as transactionLimit (C25)', async () => {
    const h = await liveHarness('ocpp2.1');
    (priv(h, 'evseWebPaymentLimits') as Map<number, unknown>).set(1, { maxCost: 5 });
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    expect(infoOf(txEvents(h, 'Started')[0])['transactionLimit']).toEqual({ maxCost: 5 });
    expect((priv(h, 'evseTransactionLimits') as Map<number, unknown>).get(1)).toEqual({
      maxCost: 5,
    });
    expect((priv(h, 'evseWebPaymentLimits') as Map<number, unknown>).has(1)).toBe(false);
  });

  it('applies a transactionLimit from the Started response with a LimitSet event', async () => {
    const h = await liveHarness('ocpp2.1', (action, payload) =>
      action === 'TransactionEvent' && payload['eventType'] === 'Started'
        ? { transactionLimit: { maxEnergy: 900000, maxTime: 7200 }, totalCost: 1 }
        : undefined,
    );
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await vi.advanceTimersByTimeAsync(0);
    const limitSet = txEvents(h, 'Updated').find((e) => e['triggerReason'] === 'LimitSet');
    expect(infoOf(limitSet)['transactionLimit']).toEqual({ maxEnergy: 900000, maxTime: 7200 });
    expect((priv(h, 'evseTotalCost') as Map<number, number>).get(1)).toBe(1);
    expect((priv(h, 'evseLimitReached') as Map<number, boolean>).get(1)).toBe(false);
  });

  it('stops at once when the reported totalCost reaches maxCost', async () => {
    const h = await liveHarness('ocpp2.1', (action, payload) =>
      action === 'TransactionEvent' && payload['eventType'] === 'Started'
        ? { transactionLimit: { maxCost: 2 } }
        : action === 'TransactionEvent' && payload['eventType'] === 'Updated'
          ? { totalCost: 3 }
          : undefined,
    );
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const reached = txEvents(h).find((e) => e['triggerReason'] === 'CostLimitReached');
    expect(reached).toBeDefined();
  });

  it('an Updated reply rejecting the idToken deauthorizes the transaction (E05)', async () => {
    const h = await liveHarness('ocpp2.1', (action, payload) =>
      action === 'TransactionEvent' &&
      payload['eventType'] === 'Updated' &&
      payload['idToken'] != null
        ? { idTokenInfo: { status: 'Invalid' } }
        : undefined,
    );
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    await h.sim.sendTransactionEvent(1, 'Updated', {
      triggerReason: 'Trigger',
      transactionId: txId,
      idToken: 'TAG-1',
    });
    await vi.advanceTimersByTimeAsync(0);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('Deauthorized');
    expect(authCache(h).get('TAG-1')).toEqual({ status: 'Invalid' });
  });
});

describe('sendTransactionEvent offline handling (E11)', () => {
  it('queues behind already-queued transaction messages', async () => {
    const h = await makeHarness();
    queue(h).push({
      action: 'TransactionEvent',
      payload: { transactionInfo: { transactionId: 'a' } },
    });
    const res = await h.sim.sendTransactionEvent(1, 'Updated', {
      triggerReason: 'Trigger',
      transactionId: 'b',
      costDetails: { totalCost: 1 },
    });
    expect(res).toEqual({});
    expect(h.sent('TransactionEvent')).toHaveLength(0);
    expect(queue(h).at(-1)?.payload).toMatchObject({
      transactionInfo: { transactionId: 'b' },
      costDetails: { totalCost: 1 },
    });
  });

  it('queues as offline when the connection drops during the send', async () => {
    const h = await makeHarness();
    h.sendCall.mockImplementation(async (action: string) => {
      if (action === 'TransactionEvent') {
        setOnline(h, false);
        throw new Error('closed');
      }
      return defaultResponse(action) as Record<string, unknown>;
    });
    const res = await h.sim.sendTransactionEvent(1, 'Updated', {
      triggerReason: 'Trigger',
      transactionId: 'b',
    });
    expect(res).toEqual({});
    expect(queue(h).at(-1)?.payload).toMatchObject({ offline: true });
  });

  it('rethrows a send error while still connected', async () => {
    const h = await makeHarness();
    h.sendCall.mockRejectedValue(new Error('timeout'));
    await expect(
      h.sim.sendTransactionEvent(1, 'Updated', { triggerReason: 'Trigger', transactionId: 'b' }),
    ).rejects.toThrow('timeout');
    expect(queue(h)).toHaveLength(0);
  });

  it('reports the default tariff of the EVSE (I07)', async () => {
    const h = await makeHarness();
    (priv(h, 'defaultTariffs') as Map<string, { evseId: number }>).set('DEF', { evseId: 1 });
    await h.sim.sendTransactionEvent(1, 'Updated', {
      triggerReason: 'Trigger',
      transactionId: 'x',
    });
    expect(infoOf(h.sent('TransactionEvent')[0])['tariffId']).toBe('DEF');
  });
});

describe('stopCharging', () => {
  it('does nothing without an active transaction', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.stopCharging(1);
    expect(h.sendCall).not.toHaveBeenCalled();
  });

  it.each([
    ['PowerLoss', 'AbnormalCondition'],
    ['MasterPass', 'StopAuthorized'],
  ])('2.1: stoppedReason %s maps to triggerReason %s', async (reason, trigger) => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.stopCharging(1, reason);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe(trigger);
    expect(infoOf(ended)['stoppedReason']).toBe(reason);
  });

  it('2.1: includes the meter values sampled for TxEndedInterval', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('SampledDataCtrlr.TxEndedInterval', '10');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await vi.advanceTimersByTimeAsync(25_000);
    await h.sim.stopCharging(1, 'Local');
    const mv = txEvents(h, 'Ended')[0]?.['meterValue'] as unknown[];
    expect(mv.length).toBeGreaterThan(1);
  });
});

describe('unplug during a transaction', () => {
  it('2.1: stops with EVCommunicationLost and Idle by default', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('EVCommunicationLost');
    expect(infoOf(ended)).toMatchObject({ chargingState: 'Idle', stoppedReason: 'EVDisconnected' });
    expect(statusOf(h)).toBe('Available');
  });

  it('2.1: suspends with StopTxOnEVSideDisconnect=false and resumes on re-plug', async () => {
    const h = await liveHarness('ocpp2.1');
    h.sim.setConfigValue('TxCtrlr.StopTxOnEVSideDisconnect', 'false');
    await h.sim.plugIn(1);
    const txId = await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    expect(txEvents(h, 'Ended')).toHaveLength(0);
    const lost = txEvents(h, 'Updated').at(-1);
    expect(lost?.['triggerReason']).toBe('EVCommunicationLost');
    expect(infoOf(lost)['chargingState']).toBe('Idle');
    expect(ctxOf(h)['state']).toBe('SuspendedEV');
    expect(statusOf(h)).toBe('Available');

    await h.sim.plugIn(1);
    const all = txEvents(h, 'Updated');
    const at = all.findIndex((e) => e['triggerReason'] === 'CablePluggedIn');
    const updates = all.slice(at, at + 2);
    expect(updates.map((e) => e['triggerReason'])).toEqual([
      'CablePluggedIn',
      'ChargingStateChanged',
    ]);
    expect(infoOf(updates[1])).toMatchObject({ transactionId: txId, chargingState: 'Charging' });
    expect(ctxOf(h)['state']).toBe('Charging');
  });

  it('1.6: StopTransactionOnEVSideDisconnect=false suspends the connector as SuspendedEV', async () => {
    const h = await liveHarness('ocpp1.6');
    h.sim.setConfigValue('StopTransactionOnEVSideDisconnect', 'false');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    expect(h.sent('StopTransaction')).toHaveLength(0);
    expect(statusOf(h)).toBe('SuspendedEV');
    expect(h.sent('StatusNotification').at(-1)).toMatchObject({ status: 'SuspendedEV' });
  });

  it('1.6: stops by default with EVDisconnected', async () => {
    const h = await liveHarness('ocpp1.6');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.unplug(1);
    expect(h.sent('StopTransaction')[0]).toMatchObject({ reason: 'EVDisconnected' });
  });
});

describe('EV and parking bay events (2.1 only)', () => {
  it('departParkingBay ends with triggerReason EVDeparted and stoppedReason Local', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.departParkingBay(1);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('EVDeparted');
    expect(infoOf(ended)['stoppedReason']).toBe('Local');
  });

  it('occupyParkingBay starts a transaction with ParkingBayOccupancy', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.occupyParkingBay(1, 'TAG-1');
    expect(txEvents(h, 'Started')[0]?.['triggerReason']).toBe('ParkingBayOccupancy');
  });

  it('all are no-ops without a transaction or on 1.6', async () => {
    const h21 = await liveHarness('ocpp2.1');
    await h21.sim.departParkingBay(1);
    expect(h21.sendCall).not.toHaveBeenCalled();

    const h16 = await liveHarness('ocpp1.6');
    await h16.sim.departParkingBay(1);
    await h16.sim.occupyParkingBay(1, 'T');
    expect(h16.sendCall).not.toHaveBeenCalled();
  });

  it('injectFault stops a running transaction with AbnormalCondition', async () => {
    const h = await liveHarness('ocpp2.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-1');
    await h.sim.injectFault(1, 'GroundFailure');
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('AbnormalCondition');
    expect(infoOf(ended)['stoppedReason']).toBe('GroundFault');
    expect(statusOf(h)).toBe('Faulted');
  });
});

describe('sendMeterValues without sampled values', () => {
  it('2.1: generates values from the meter generator', async () => {
    const h = await makeHarness();
    await h.sim.sendMeterValues(1);
    const mv = h.sent('MeterValues')[0];
    expect(mv?.['evseId']).toBe(1);
    const values = (mv?.['meterValue'] as Array<{ sampledValue: unknown[] }>)[0]?.sampledValue;
    expect(values?.length).toBeGreaterThan(0);
  });

  it('1.6: sends the transaction id and an empty list for an EVSE without a generator', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.sim.sendMeterValues(9, undefined, '77');
    expect(h.sent('MeterValues')[0]).toMatchObject({
      connectorId: 9,
      transactionId: 77,
      meterValue: [{ sampledValue: [] }],
    });
  });
});

describe('rebootStation and comeOnline', () => {
  it('1.6: boots with RemoteReset and reports idle connectors Available', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6', boot: true });
    h.sendCall.mockClear();
    ctxOf(h)['cablePlugged'] = true;
    await h.sim.rebootStation();
    expect(h.sent('BootNotification')).toHaveLength(1);
    expect(h.sent('StatusNotification')).toContainEqual(
      expect.objectContaining({ connectorId: 1, status: 'Available' }),
    );
    expect(ctxOf(h)['cablePlugged']).toBe(false);
  });

  it('does nothing offline and stops when the boot is not Accepted', async () => {
    const off = await makeHarness({ protocol: 'ocpp1.6', connected: false });
    await off.sim.rebootStation();
    expect(off.sendCall).not.toHaveBeenCalled();

    const pending = await makeHarness({
      protocol: 'ocpp1.6',
      respond: (action) =>
        action === 'BootNotification'
          ? { status: 'Rejected', interval: 30, currentTime: new Date().toISOString() }
          : undefined,
    });
    await pending.sim.rebootStation();
    expect(pending.actions()).toEqual(['BootNotification']);
  });

  it('comeOnline restarts a station taken offline', async () => {
    const h = await makeHarness({ connected: false });
    await h.sim.comeOnline();
    expect(h.sent('BootNotification')[0]).toMatchObject({ reason: 'PowerUp' });
  });
});

describe('misc helpers', () => {
  it('invalidateProfilesAfterOffline marks only profiles past their maxOfflineDuration', async () => {
    const h = await makeHarness();
    const cache = priv(h, 'chargingProfilesCache') as Map<number, Record<string, unknown>>;
    cache.set(1, { id: 1, maxOfflineDuration: 10, invalidAfterOfflineDuration: true });
    cache.set(2, { id: 2, maxOfflineDuration: 100, invalidAfterOfflineDuration: true });
    cache.set(3, { id: 3, maxOfflineDuration: 10 });
    call(h, 'invalidateProfilesAfterOffline', 50_000);
    expect(cache.get(1)?.['_invalidated']).toBe(true);
    expect(cache.get(2)?.['_invalidated']).toBeUndefined();
    expect(cache.get(3)?.['_invalidated']).toBeUndefined();
  });

  it('1.6: sendFirmwareStatusNotification sends only the status', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.sim.sendFirmwareStatusNotification('Downloading', 4);
    expect(h.sent('FirmwareStatusNotification')).toEqual([{ status: 'Downloading' }]);
  });
});
