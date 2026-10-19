// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { TC_K_114_CSMS } from '../tests/v2_1/csms/K-smart-charging/TC_K_57_CSMS.js';
import { makeRenegotiationContext, startedTransactionId } from './helpers/renegotiation-context.js';

describe('TC_K_114_CSMS (K17 renegotiation initiated by the EV, ISO 15118-20)', () => {
  it('triggers a TxProfile for the transaction and passes when the CSMS sends it', async () => {
    const { ctx, sendCall, triggerCommand } = makeRenegotiationContext(
      'TC_K_114_CSMS',
      (request) => request,
    );

    const result = await TC_K_114_CSMS.execute(ctx);

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
    const sentProfile = (
      triggerCommand.mock.calls[0]?.[2] as { chargingProfile: { chargingSchedule: unknown[] } }
    ).chargingProfile;
    const scheduleCall = sendCall.mock.calls.find(
      ([action]) => action === 'NotifyEVChargingSchedule',
    );
    expect(scheduleCall?.[1]).toMatchObject({
      evseId: 1,
      chargingSchedule: sentProfile.chargingSchedule[0],
    });
    expect(result.status).toBe('passed');
  });

  it('fails step 2 when the CSMS answers NoChargingProfile', async () => {
    const { ctx } = makeRenegotiationContext('TC_K_114_CSMS', (request) => request, {
      needsStatus: 'NoChargingProfile',
    });

    const result = await TC_K_114_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 2)).toMatchObject({
      status: 'failed',
      actual: 'status = NoChargingProfile',
    });
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the CSMS sends no SetChargingProfileRequest', async () => {
    const { ctx, sendCall } = makeRenegotiationContext('TC_K_114_CSMS', () => null);

    const result = await TC_K_114_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 3)).toMatchObject({
      status: 'failed',
      actual: 'No SetChargingProfileRequest received',
    });
    expect(sendCall.mock.calls.some(([action]) => action === 'NotifyEVChargingSchedule')).toBe(
      false,
    );
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the profile is a TxDefaultProfile without the transaction', async () => {
    const { ctx } = makeRenegotiationContext('TC_K_114_CSMS', (request) => {
      const profile = { ...(request['chargingProfile'] as Record<string, unknown>) };
      delete profile['transactionId'];
      return {
        ...request,
        chargingProfile: { ...profile, chargingProfilePurpose: 'TxDefaultProfile' },
      };
    });

    const result = await TC_K_114_CSMS.execute(ctx);

    const step3 = result.steps.find((s) => s.step === 3);
    expect(step3?.status).toBe('failed');
    expect(step3?.actual).toContain('chargingProfilePurpose = TxDefaultProfile');
    expect(step3?.actual).toContain('transactionId = undefined');
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the profile targets another EVSE', async () => {
    const { ctx } = makeRenegotiationContext('TC_K_114_CSMS', (request) => ({
      ...request,
      evseId: 2,
    }));

    const result = await TC_K_114_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 3)?.status).toBe('failed');
    expect(result.status).toBe('failed');
  });

  it('fails step 3 when the profile holds more than one chargingSchedule', async () => {
    const { ctx } = makeRenegotiationContext('TC_K_114_CSMS', (request) => {
      const profile = request['chargingProfile'] as { chargingSchedule: unknown[] };
      const schedule = profile.chargingSchedule[0] as Record<string, unknown>;
      return {
        ...request,
        chargingProfile: {
          ...profile,
          chargingSchedule: [schedule, { ...schedule, id: 2 }],
        },
      };
    });

    const result = await TC_K_114_CSMS.execute(ctx);

    const step3 = result.steps.find((s) => s.step === 3);
    expect(step3?.status).toBe('failed');
    expect(step3?.actual).toContain('chargingSchedule size = 2');
    expect(result.status).toBe('failed');
  });

  it('fails step 6 when the CSMS rejects the NotifyEVChargingScheduleRequest', async () => {
    const { ctx } = makeRenegotiationContext('TC_K_114_CSMS', (request) => request, {
      scheduleStatus: 'Rejected',
    });

    const result = await TC_K_114_CSMS.execute(ctx);

    expect(result.steps.find((s) => s.step === 6)?.status).toBe('failed');
    expect(result.status).toBe('failed');
  });
});
