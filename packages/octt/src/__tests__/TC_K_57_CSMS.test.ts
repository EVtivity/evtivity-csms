// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TC_K_57_CSMS } from '../tests/v2_1/csms/K-smart-charging/TC_K_57_CSMS.js';
import type { OcppVersion, TestContext } from '../types.js';

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type Forward = (payload: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * A CSMS that forwards the triggered SetChargingProfile to the station as
 * `forward` shapes it (null: it sends nothing), and answers every station
 * request Accepted.
 */
function makeContext(version: OcppVersion, forward: Forward, needsStatus = 'Accepted') {
  let handler: IncomingHandler | null = null;
  const sendCall = vi.fn((action: string, _payload: Record<string, unknown>) => {
    if (action === 'BootNotification') {
      return Promise.resolve({ status: 'Accepted', currentTime: '', interval: 300 });
    }
    if (action === 'NotifyEVChargingNeeds') return Promise.resolve({ status: needsStatus });
    if (action === 'NotifyEVChargingSchedule') return Promise.resolve({ status: 'Accepted' });
    return Promise.resolve({});
  });
  const triggerCommand = vi.fn(
    async (_version: string, _action: string, payload: Record<string, unknown>) => {
      if (handler == null) throw new Error('no incoming handler');
      const request = { ...payload };
      delete request['stationId'];
      const sent = forward(request);
      if (sent == null) return {};
      return handler('m1', 'SetChargingProfile', sent);
    },
  );
  const ctx: TestContext = {
    client: {
      sendCall,
      setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
        handler = h;
      }),
    } as unknown as TestContext['client'],
    version,
    stationId: 'OCTT-K-smart-charging-TC_K_57_CSMS-test',
    tokens: { valid: 'OCTTVALID0000001' } as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://localhost:7103' },
    triggerCommand,
  };
  return { ctx, sendCall, triggerCommand };
}

function startedTransactionId(sendCall: ReturnType<typeof vi.fn>): string {
  const call = sendCall.mock.calls.find(([action]) => action === 'TransactionEvent');
  const payload = call?.[1] as { transactionInfo: { transactionId: string } };
  return payload.transactionInfo.transactionId;
}

describe('TC_K_57_CSMS (K17 renegotiation initiated by the EV)', () => {
  for (const version of ['ocpp2.1', 'ocpp2.0.1'] as const) {
    it(`${version}: triggers a TxProfile for the transaction and passes when the CSMS sends it`, async () => {
      const { ctx, sendCall, triggerCommand } = makeContext(version, (request) => request);

      const result = await TC_K_57_CSMS.execute(ctx);

      const txId = startedTransactionId(sendCall);
      expect(triggerCommand).toHaveBeenCalledWith(
        'v21',
        'SetChargingProfile',
        expect.objectContaining({
          evseId: 1,
          chargingProfile: expect.objectContaining({
            chargingProfilePurpose: 'TxProfile',
            transactionId: txId,
          }) as unknown,
        }),
      );
      expect(result.steps.map((s) => [s.step, s.status])).toEqual([
        [2, 'passed'],
        [3, 'passed'],
        [6, 'passed'],
      ]);
      // Step 5 sends the schedule the CSMS provided at step 3.
      const scheduleCall = sendCall.mock.calls.find(
        ([action]) => action === 'NotifyEVChargingSchedule',
      );
      const sentProfile = (
        triggerCommand.mock.calls[0]?.[2] as {
          chargingProfile: { chargingSchedule: unknown[] };
        }
      ).chargingProfile;
      expect(scheduleCall?.[1]).toMatchObject({
        evseId: 1,
        chargingSchedule: sentProfile.chargingSchedule[0],
      });
      expect(result.status).toBe('passed');
    });
  }

  // Both the 2.1 and the 2.0.1 case documents allow only Accepted or Processing at step 2.
  for (const version of ['ocpp2.1', 'ocpp2.0.1'] as const) {
    it(`${version}: passes step 2 on Processing and fails it on NoChargingProfile`, async () => {
      const processing = makeContext(version, (request) => request, 'Processing');
      const passed = await TC_K_57_CSMS.execute(processing.ctx);
      expect(passed.steps.find((s) => s.step === 2)?.status).toBe('passed');

      const noProfile = makeContext(version, (request) => request, 'NoChargingProfile');
      const failed = await TC_K_57_CSMS.execute(noProfile.ctx);
      expect(failed.steps.find((s) => s.step === 2)).toMatchObject({
        status: 'failed',
        expected: 'status = Accepted or Processing',
        actual: 'status = NoChargingProfile',
      });
      expect(failed.status).toBe('failed');
    });
  }

  it('fails step 3 when the CSMS sends no SetChargingProfileRequest', async () => {
    const { ctx, sendCall } = makeContext('ocpp2.1', () => null);

    const result = await TC_K_57_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 3)).toMatchObject({
      status: 'failed',
      actual: 'No SetChargingProfileRequest received',
    });
    expect(sendCall.mock.calls.some(([action]) => action === 'NotifyEVChargingSchedule')).toBe(
      false,
    );
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the profile is not a TxProfile for the transaction', async () => {
    const { ctx } = makeContext('ocpp2.0.1', (request) => {
      const profile = { ...(request['chargingProfile'] as Record<string, unknown>) };
      delete profile['transactionId'];
      return {
        ...request,
        chargingProfile: { ...profile, chargingProfilePurpose: 'TxDefaultProfile' },
      };
    });

    const result = await TC_K_57_CSMS.execute(ctx);

    const step3 = result.steps.find((s) => s.step === 3);
    expect(step3?.status).toBe('failed');
    expect(step3?.actual).toContain('chargingProfilePurpose = TxDefaultProfile');
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the profile targets another EVSE', async () => {
    const { ctx } = makeContext('ocpp2.1', (request) => ({ ...request, evseId: 2 }));

    const result = await TC_K_57_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 3)?.status).toBe('failed');
    expect(result.status).toBe('failed');
  });
});
