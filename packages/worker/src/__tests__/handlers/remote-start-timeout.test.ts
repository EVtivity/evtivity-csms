// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockClose, mockFailGuest, mockAudit, NotConfigured } = vi.hoisted(() => {
  class NotConfigured extends Error {
    readonly providerId: string;
    constructor(providerId: string) {
      super(`Payment provider ${providerId} is not configured`);
      this.providerId = providerId;
    }
  }
  return {
    mockClose: vi.fn(),
    mockFailGuest: vi.fn(),
    mockAudit: vi.fn(),
    NotConfigured,
  };
});

vi.mock('@evtivity/payments', () => ({
  closeUnstartedRemoteStart: mockClose,
  failUnstartedGuestSession: mockFailGuest,
  PaymentProviderNotConfiguredError: NotConfigured,
}));

vi.mock('@evtivity/database', () => ({
  writeReservationAudit: mockAudit,
  EV_CONNECT_TIMEOUT_REASON: 'EVConnectTimeout',
}));

vi.mock('../../lib/payments.js', () => ({
  paymentContext: (logger: unknown) => ({ registry: 'registry', logger }),
}));

import { handleRemoteStartTimeout } from '../../handlers/remote-start-timeout.js';

function makeLog(): Logger & Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

const session = {
  id: 'ses_1',
  stationUuid: 'sta_1',
  siteId: 'sit_1',
  driverId: 'drv_1',
  reservationId: null,
};

describe('handleRemoteStartTimeout', () => {
  const publish = vi.fn();
  const pubsub = { publish, subscribe: vi.fn(), close: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    publish.mockResolvedValue(undefined);
  });

  it('fails an unstarted session, cancels its hold and refreshes the operator UI', async () => {
    mockClose.mockResolvedValueOnce({
      outcome: 'failed',
      session,
      hold: { status: 'cancelled', paymentRecordId: 7 },
    });
    const log = makeLog();

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, log, pubsub);

    expect(mockClose).toHaveBeenCalledWith('ses_1', { registry: 'registry', logger: log });
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'session.ended',
        stationId: 'sta_1',
        siteId: 'sit_1',
        sessionId: 'ses_1',
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { sessionId: 'ses_1', outcome: 'failed', hold: 'cancelled' },
      'Remote start timeout checked',
    );
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('writes the reservation timeline entry of a reserved session', async () => {
    mockClose.mockResolvedValueOnce({
      outcome: 'failed',
      session: { ...session, reservationId: 'rsv_1' },
      hold: { status: 'none' },
    });
    const log = makeLog();

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, log, pubsub);

    expect(mockAudit).toHaveBeenCalledWith(
      {
        reservationId: 'rsv_1',
        action: 'session_failed',
        actor: 'system',
        notes: 'session ses_1: failed: EVConnectTimeout',
      },
      undefined,
      log,
    );
  });

  it('does nothing more for a started session', async () => {
    mockClose.mockResolvedValueOnce({ outcome: 'skipped' });

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, makeLog(), pubsub);

    expect(publish).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('announces nothing again when a retry finds the session closed', async () => {
    mockClose.mockResolvedValueOnce({ outcome: 'closed', session, hold: { status: 'none' } });

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, makeLog(), pubsub);

    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps going when the UI refresh publish fails (fail-open)', async () => {
    mockClose.mockResolvedValueOnce({ outcome: 'failed', session, hold: { status: 'none' } });
    publish.mockRejectedValueOnce(new Error('redis down'));
    const log = makeLog();

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, log, pubsub);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'session.ended publish failed; continuing',
    );
  });

  it('publishes nothing without a pub/sub client', async () => {
    mockClose.mockResolvedValueOnce({ outcome: 'failed', session, hold: { status: 'none' } });

    await handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, makeLog(), null);

    expect(publish).not.toHaveBeenCalled();
  });

  it('fails an unstarted guest session through the payments service', async () => {
    mockFailGuest.mockResolvedValueOnce({ outcome: 'failed', holdCancelled: true });
    const log = makeLog();

    await handleRemoteStartTimeout({ kind: 'guest', guestSessionId: 301 }, log, pubsub);

    expect(mockFailGuest).toHaveBeenCalledWith(301, { registry: 'registry', logger: log });
    expect(mockClose).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { guestSessionId: 301, outcome: 'failed', holdCancelled: true },
      'Remote start timeout checked (guest)',
    );
  });

  it('rethrows a provider error so the queue retries', async () => {
    mockClose.mockRejectedValueOnce(new Error('provider timeout'));

    await expect(
      handleRemoteStartTimeout({ kind: 'session', sessionId: 'ses_1' }, makeLog(), pubsub),
    ).rejects.toThrow('provider timeout');
  });

  it('logs and does not retry when the hold provider is not configured', async () => {
    mockFailGuest.mockRejectedValueOnce(new NotConfigured('adyen'));
    const log = makeLog();

    await handleRemoteStartTimeout({ kind: 'guest', guestSessionId: 302 }, log, pubsub);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'guest', guestSessionId: 302 } }),
      'Payment provider of the hold not configured; hold of the unstarted start left open',
    );
  });
});
