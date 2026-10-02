// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { StationSimulator } from '../station-simulator.js';
import { noopSql, makeConfig } from './sim-test-helpers.js';

function activeTransactionIds(sim: StationSimulator): Map<number, string> {
  return (sim as unknown as { activeTransactionIds: Map<number, string> }).activeTransactionIds;
}

function loadConfigVariables(sim: StationSimulator): Promise<void> {
  return (sim as unknown as { loadConfigVariables(): Promise<void> }).loadConfigVariables();
}

describe('StationSimulator test transaction', () => {
  it('boots a 2.1 station with no active transaction', async () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    await loadConfigVariables(sim);
    expect(activeTransactionIds(sim).size).toBe(0);
  });

  it('seeds test-tx only when a test asks for it', () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    sim.setConfigValue('_seedTestTransaction', 'true');
    expect(activeTransactionIds(sim).get(1)).toBe('test-tx');
  });
});
