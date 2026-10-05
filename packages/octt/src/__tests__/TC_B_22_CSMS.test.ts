// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { TC_B_22_CSMS } from '../tests/v2_1/csms/B-provisioning/TC_B_22_CSMS.js';
import type { TestContext } from '../types.js';

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * A loaded CSMS: TransactionEvent Ended takes `endedDelayMs` to answer (dev,
 * nightly cycle 2: more than 2.7 s on the 0.25 vCPU OCPP task), and the Reset
 * trigger returns once the station answered the ResetRequest.
 */
function makeContext(endedDelayMs: number): TestContext {
  let handler: IncomingHandler | null = null;
  const sendCall = vi.fn((action: string, payload: Record<string, unknown>) => {
    if (action === 'TransactionEvent' && payload['eventType'] === 'Ended') {
      return new Promise((resolve) => setTimeout(() => resolve({}), endedDelayMs));
    }
    if (action === 'BootNotification') {
      return Promise.resolve({ status: 'Accepted', currentTime: '', interval: 300 });
    }
    return Promise.resolve({});
  });
  const triggerCommand = vi.fn(async () => {
    if (handler == null) throw new Error('no incoming handler');
    return handler('m1', 'Reset', { type: 'Immediate' });
  });
  return {
    client: {
      sendCall,
      setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
        handler = h;
      }),
    } as unknown as TestContext['client'],
    stationId: 'OCTT-B-provisioning-TC_B_22_CSMS-test',
    tokens: { valid: 'OCTTVALID0000001' } as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://localhost:7103' },
    triggerCommand,
  };
}

describe('TC_B_22_CSMS under load', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the reboot after a slow TransactionEvent Ended instead of a fixed 3 s', async () => {
    vi.useFakeTimers();
    const run = TC_B_22_CSMS.execute(makeContext(4_000));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await run;
    expect(result.steps.find((s) => s.step === 4)).toMatchObject({
      status: 'passed',
      actual: 'status = Accepted',
    });
    expect(result.status).toBe('passed');
  });

  it('fails with the reason when the CSMS never answers', async () => {
    vi.useFakeTimers();
    const run = TC_B_22_CSMS.execute(makeContext(1_000_000));
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await run;
    expect(result.steps.find((s) => s.step === 4)).toMatchObject({
      status: 'failed',
      actual: 'Station sequence not finished within 90 s',
    });
  });
});
