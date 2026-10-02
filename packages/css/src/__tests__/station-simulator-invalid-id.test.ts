// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { StationSimulator } from '../station-simulator.js';
import { makeConfig } from './sim-test-helpers.js';

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

interface Internals {
  seedDefaultConfigVariables(): void;
  meterGens: Map<number, object>;
  activeTransactionIds: Map<number, string>;
  evseInvalidIdMaxEnergy: Map<number, number>;
  handleRejectedTransactionIdToken(evseId: number): Promise<void>;
}

/**
 * A connected 2.1 station whose CSMS accepts Authorize and answers every TransactionEvent
 * that carries an idToken with idTokenInfo.status Invalid.
 */
function makeSimulator(config: Record<string, string>): {
  sim: StationSimulator;
  internals: Internals;
  transactionEvents: () => Array<Record<string, unknown>>;
} {
  const sim = new StationSimulator(makeConfig(), noopSql());
  const sendCall = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent' && payload['idToken'] != null)
      return { idTokenInfo: { status: 'Invalid' } };
    return {};
  });
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'isConnected', { get: () => true });
  const internals = sim as unknown as Internals;
  internals.seedDefaultConfigVariables();
  // css_transactions lives in the database: answer from the in-memory transactions
  Object.defineProperty(sim, 'getActiveTransaction', {
    value: async (evseId: number) => {
      const transactionId = internals.activeTransactionIds.get(evseId);
      return transactionId != null
        ? { transactionId, meterStartWh: 0, idToken: 'BLOCKED-1' }
        : null;
    },
  });
  for (const [key, value] of Object.entries(config)) sim.setConfigValue(key, value);
  const transactionEvents = (): Array<Record<string, unknown>> =>
    sendCall.mock.calls
      .filter((c) => c[0] === 'TransactionEvent' && c[1]['triggerReason'] !== 'MeterValuePeriodic')
      .map((c) => c[1]);
  return { sim, internals, transactionEvents };
}

const chargingStates = (events: Array<Record<string, unknown>>): unknown[] =>
  events.map((e) => (e['transactionInfo'] as Record<string, unknown>)['chargingState']);

async function startRejected(sim: StationSimulator): Promise<void> {
  await sim.plugIn(1);
  await sim.startCharging(1, 'BLOCKED-1');
}

describe('TransactionEventResponse with a rejected idToken (E05, live)', () => {
  it('StopTxOnInvalidId true: ends the transaction with Deauthorized (E05.FR.10)', async () => {
    const { sim, transactionEvents } = makeSimulator({
      'TxCtrlr.StopTxOnInvalidId': 'true',
      'TxCtrlr.MaxEnergyOnInvalidId': '500',
    });
    await startRejected(sim);

    const events = transactionEvents();
    expect(events.map((e) => e['eventType'])).toEqual(['Started', 'Ended']);
    const ended = events[1] as Record<string, unknown>;
    expect(ended['triggerReason']).toBe('Deauthorized');
    expect((ended['transactionInfo'] as Record<string, unknown>)['stoppedReason']).toBe(
      'DeAuthorized',
    );
    expect(chargingStates(events)).not.toContain('Charging');
  });

  it('StopTxOnInvalidId false without MaxEnergyOnInvalidId: suspends (E05.FR.02)', async () => {
    const { sim, transactionEvents } = makeSimulator({
      'TxCtrlr.StopTxOnInvalidId': 'false',
      'TxCtrlr.MaxEnergyOnInvalidId': '0',
    });
    await startRejected(sim);

    const events = transactionEvents();
    expect(events.map((e) => e['eventType'])).toEqual(['Started', 'Updated']);
    expect(events[1]?.['triggerReason']).toBe('ChargingStateChanged');
    expect(chargingStates(events)).toEqual(['EVConnected', 'SuspendedEVSE']);
  });

  it('StopTxOnInvalidId false with MaxEnergyOnInvalidId: charges until it is delivered (E05.FR.03)', async () => {
    const { sim, internals, transactionEvents } = makeSimulator({
      'TxCtrlr.StopTxOnInvalidId': 'false',
      'TxCtrlr.MaxEnergyOnInvalidId': '10000',
    });
    await startRejected(sim);

    expect(chargingStates(transactionEvents())).toContain('Charging');
    expect(chargingStates(transactionEvents())).not.toContain('SuspendedEVSE');
    expect(internals.evseInvalidIdMaxEnergy.get(1)).toBe(10000);

    // The allowed energy is delivered: the next check suspends the energy transfer
    const gen = internals.meterGens.get(1) as object;
    Object.defineProperty(gen, 'energyWh', { get: () => 10000 });
    await internals.handleRejectedTransactionIdToken(1);

    const events = transactionEvents();
    expect(events.at(-1)?.['triggerReason']).toBe('ChargingStateChanged');
    expect(chargingStates(events).at(-1)).toBe('SuspendedEVSE');
    expect(events.some((e) => e['eventType'] === 'Ended')).toBe(false);
    await sim.stopCharging(1, 'Local');
  });

  it('an Accepted idToken starts charging normally', async () => {
    const { sim } = makeSimulator({});
    const accepted = vi.fn(async () => ({ idTokenInfo: { status: 'Accepted' } }));
    Object.defineProperty(sim.client, 'sendCall', { value: accepted, writable: true });
    await startRejected(sim);
    const states = accepted.mock.calls
      .filter((c: unknown[]) => c[0] === 'TransactionEvent')
      .map((c: unknown[]) => {
        const info = (c[1] as Record<string, unknown>)['transactionInfo'];
        return (info as Record<string, unknown>)['chargingState'];
      });
    expect(states.slice(0, 2)).toEqual(['EVConnected', 'Charging']);
    expect(states).not.toContain('SuspendedEVSE');
    await sim.stopCharging(1, 'Local');
  });
});
