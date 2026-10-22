// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { monitorClearOutcome, monitorSetOutcome } from '../variable-monitoring.js';

const base = { commandId: 'c' };

describe('monitorSetOutcome', () => {
  it('is active with the station monitor id on Accepted', () => {
    expect(
      monitorSetOutcome({
        ...base,
        response: { setMonitoringResult: [{ id: 7, status: 'Accepted' }] },
      }),
    ).toEqual({ status: 'active', monitoringId: 7, errorInfo: null });
  });

  it('is an error when Accepted carries no monitor id', () => {
    expect(
      monitorSetOutcome({ ...base, response: { setMonitoringResult: [{ status: 'Accepted' }] } }),
    ).toMatchObject({ status: 'error', monitoringId: null });
  });

  it('is an error with the status and reason when refused', () => {
    expect(
      monitorSetOutcome({
        ...base,
        response: {
          setMonitoringResult: [
            {
              status: 'Rejected',
              statusInfo: { reasonCode: 'ValueOutOfRange', additionalInfo: 'negative delta' },
            },
          ],
        },
      }),
    ).toEqual({
      status: 'error',
      monitoringId: null,
      errorInfo: 'Rejected: ValueOutOfRange (negative delta)',
    });
  });

  it('is an error on a timeout, a send failure or an empty reply', () => {
    expect(monitorSetOutcome({ ...base, error: 'x', timedOut: true }).errorInfo).toBe(
      'No response from station',
    );
    expect(monitorSetOutcome({ ...base, error: 'Station offline' }).errorInfo).toBe(
      'Station offline',
    );
    expect(monitorSetOutcome({ ...base, response: {} }).status).toBe('error');
  });
});

describe('monitorClearOutcome', () => {
  it('is cleared on Accepted and NotFound', () => {
    for (const status of ['Accepted', 'NotFound']) {
      expect(
        monitorClearOutcome(
          { ...base, response: { clearMonitoringResult: [{ id: 3, status }] } },
          3,
        ),
      ).toEqual({ kind: 'cleared' });
    }
  });

  it('picks the result for the monitor id', () => {
    expect(
      monitorClearOutcome(
        {
          ...base,
          response: {
            clearMonitoringResult: [
              { id: 1, status: 'Accepted' },
              { id: 3, status: 'Rejected' },
            ],
          },
        },
        3,
      ),
    ).toEqual({ kind: 'rejected', errorInfo: 'Rejected' });
  });

  it('is failed on a timeout or an empty reply', () => {
    expect(monitorClearOutcome({ ...base, error: 'x', timedOut: true }, 3)).toMatchObject({
      kind: 'failed',
      timedOut: true,
    });
    expect(monitorClearOutcome({ ...base, response: {} }, 3)).toMatchObject({
      kind: 'failed',
      timedOut: false,
    });
  });
});
