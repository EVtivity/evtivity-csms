// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ChangeAvailability through the shared command path: the canonical 2.1
// payload without a version (the OCPP server translates for 1.6), an EVSE or
// connector target, and the result classified as offline, failed or the
// station's lower-cased status.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../ocpp-command.js', () => ({ sendOcppCommandAndWait: send }));

const { sendAvailabilityCommand } = await import('../availability-command.js');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendAvailabilityCommand', () => {
  it('sends a station-wide change and lower-cases the station status', async () => {
    send.mockResolvedValue({ response: { status: 'Scheduled' } });
    const out = await sendAvailabilityCommand('CS-1', 'Inoperative', logger);
    expect(send).toHaveBeenCalledWith('CS-1', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    expect(out).toEqual({
      command: 'ChangeAvailability(Inoperative)',
      commandStatus: 'scheduled',
      error: null,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('targets an EVSE, or one connector of it', async () => {
    send.mockResolvedValue({ response: {} });
    const evse = await sendAvailabilityCommand('CS-1', 'Operative', undefined, { evseId: 2 });
    expect(send.mock.calls[0]![2]).toEqual({ operationalStatus: 'Operative', evse: { id: 2 } });
    // A reply without a status counts as accepted.
    expect(evse.commandStatus).toBe('accepted');
    await sendAvailabilityCommand('CS-1', 'Operative', undefined, { evseId: 2, connectorId: 1 });
    expect(send.mock.calls[1]![2]).toEqual({
      operationalStatus: 'Operative',
      evse: { id: 2, connectorId: 1 },
    });
  });

  it('reports an offline station and a failed command with a warning', async () => {
    send.mockResolvedValueOnce({ error: 'Station CS-1 is not connected' });
    expect(await sendAvailabilityCommand('CS-1', 'Inoperative', logger as never)).toEqual({
      command: 'ChangeAvailability(Inoperative)',
      commandStatus: 'offline',
      error: 'Station CS-1 is not connected',
    });
    send.mockResolvedValueOnce({ error: 'timeout' });
    expect(
      (await sendAvailabilityCommand('CS-1', 'Inoperative', logger as never)).commandStatus,
    ).toBe('failed');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { stationId: 'CS-1', error: 'timeout' },
      'ChangeAvailability(Inoperative) failed',
    );
  });

  it('answers failed when sending throws, with the message or a fallback', async () => {
    send.mockRejectedValueOnce(new Error('redis down'));
    expect(await sendAvailabilityCommand('CS-1', 'Operative', logger as never)).toEqual({
      command: 'ChangeAvailability(Operative)',
      commandStatus: 'failed',
      error: 'redis down',
    });
    send.mockRejectedValueOnce('not an error');
    expect((await sendAvailabilityCommand('CS-1', 'Operative')).error).toBe('Unknown error');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
