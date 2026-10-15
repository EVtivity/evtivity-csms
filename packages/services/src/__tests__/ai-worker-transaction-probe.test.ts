// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import {
  TRANSACTION_PROBE_TIMEOUT_MS,
  probeTransactionOngoing,
} from '../ai-workers/transaction-probe.js';
import type { ProbeSender } from '../ai-workers/transaction-probe.js';
import { stuckBillingCode, stuckSessionProposal } from '../ai-workers/proposals.js';

const session = {
  sessionId: 'ses_000000000001',
  ocppStationId: 'CS-21',
  ocppProtocol: 'ocpp2.1',
  transactionId: 'tx-1',
  reason: 'no_activity' as const,
};

function logger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

function sender(result: Awaited<ReturnType<ProbeSender>>) {
  return vi.fn<ProbeSender>(() => Promise.resolve(result));
}

describe('stuck session transaction probe (GetTransactionStatus)', () => {
  it('asks an online 2.1 station once, natively, with a short timeout', async () => {
    const send = sender({
      commandId: 'c',
      response: { ongoingIndicator: true, messagesInQueue: false },
    });
    const log = logger();
    expect(await probeTransactionOngoing(session, log, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'CS-21',
      'GetTransactionStatus',
      { transactionId: 'tx-1' },
      '2.1',
      { timeoutMs: TRANSACTION_PROBE_TIMEOUT_MS },
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports a transaction the station no longer runs', async () => {
    const send = sender({
      commandId: 'c',
      response: { ongoingIndicator: false, messagesInQueue: true },
    });
    expect(await probeTransactionOngoing(session, logger(), send)).toBe(false);
  });

  it('never asks a 1.6 station or the station of an offline session', async () => {
    const send = sender({ commandId: 'c', response: { ongoingIndicator: true } });
    const log = logger();
    expect(
      await probeTransactionOngoing({ ...session, ocppProtocol: 'ocpp1.6' }, log, send),
    ).toBeNull();
    expect(await probeTransactionOngoing({ ...session, ocppProtocol: null }, log, send)).toBeNull();
    expect(
      await probeTransactionOngoing({ ...session, reason: 'station_offline' }, log, send),
    ).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it.each([
    ['a timeout', { commandId: 'c', error: 'No response within 10s', timedOut: true }],
    ['a command error', { commandId: 'c', error: 'Internal error sending command' }],
    [
      'a queued command (the station went offline)',
      { commandId: 'c', error: 'Station offline, command queued', queued: true },
    ],
  ])('fails open on %s and logs a warning', async (_name, result) => {
    const log = logger();
    expect(await probeTransactionOngoing(session, log, sender(result))).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open when the sender throws', async () => {
    const log = logger();
    const send = vi.fn<ProbeSender>(() => Promise.reject(new Error('redis down')));
    expect(await probeTransactionOngoing(session, log, send)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('treats an answer without ongoingIndicator as unknown', async () => {
    const log = logger();
    const send = sender({ commandId: 'c', response: { messagesInQueue: false } });
    expect(await probeTransactionOngoing(session, log, send)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('stuck session billing codes', () => {
  it('names how each action bills the session', () => {
    expect(stuckBillingCode('end_session', null)).toBe('stuckSessionEnd');
    expect(stuckBillingCode('end_session', true)).toBe('stuckSessionEnd');
    expect(stuckBillingCode('stop_transaction', true)).toBe('stuckSessionStopOngoing');
    expect(stuckBillingCode('stop_transaction', false)).toBe('stuckSessionStopNotOngoing');
    expect(stuckBillingCode('stop_transaction', null)).toBe('stuckSessionStop');
  });

  it('puts the station answer and the billing params on the stop suggestion', () => {
    const suggestion = stuckSessionProposal(
      {
        sessionId: 'ses_000000000001',
        stationId: 'sta_000000000001',
        ocppStationId: 'CS-21',
        ocppProtocol: 'ocpp2.1',
        ocppEvseId: 1,
        transactionId: 'tx-1',
        siteId: null,
        reason: 'connector_available',
        stationOfflineSince: null,
        energyWh: 9_500,
        currentCostCents: null,
        currency: 'USD',
        startedAt: null,
        lastActivityAt: new Date(Date.now() - 20 * 60_000),
      },
      {
        idleMinutes: 90,
        offlineEndAfterHours: 24,
        expiresAt: new Date(Date.now() + 3_600_000),
        workerRunId: null,
        period: '2026-10-15T10:00',
        now: new Date(),
        transactionOngoing: false,
      },
    );
    expect(suggestion?.action?.summary).toMatchObject({
      action: 'stop_transaction',
      transactionOngoing: false,
      rationale: { code: 'stuckSessionConnectorAvailable' },
      billing: {
        code: 'stuckSessionStopNotOngoing',
        params: { energyWh: 9_500, costCents: null, currency: 'USD' },
      },
    });
  });
});
