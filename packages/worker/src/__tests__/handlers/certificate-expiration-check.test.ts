// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `client` is the postgres tagged-template fn. Each tagged-template call in the
// handler invokes mockClient(stringsArray, ...interpolations). Results are
// queued in call order: settings SELECT, expired-station UPDATE, expired-CA
// UPDATE, critical-certs SELECT, warning-certs SELECT.
const mockClient = vi.fn();
vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => mockClient(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => 'fixed-uuid',
}));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function settingsRows(
  enabled: unknown,
  opts: { criticalDays?: unknown; warningDays?: unknown } = {},
): Array<{ key: string; value: unknown }> {
  const rows: Array<{ key: string; value: unknown }> = [{ key: 'pnc.enabled', value: enabled }];
  if ('criticalDays' in opts)
    rows.push({ key: 'pnc.expirationCriticalDays', value: opts.criticalDays });
  if ('warningDays' in opts)
    rows.push({ key: 'pnc.expirationWarningDays', value: opts.warningDays });
  return rows;
}

describe('certificateExpirationCheckHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.mockReset();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
  });

  it('returns early without touching the DB when PnC is disabled', async () => {
    mockClient.mockResolvedValueOnce(settingsRows(false));

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    // Only the settings SELECT ran. No expiry UPDATE/SELECT, no publishes.
    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns early when pnc.enabled is missing entirely', async () => {
    // No pnc.enabled row at all -> Map.get returns undefined !== true.
    mockClient.mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('marks expired station and CA certs and logs counts', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([{ id: 'sc_1' }, { id: 'sc_2' }]) // expired station certs
      .mockResolvedValueOnce([{ id: 'ca_1' }]) // expired CA certs
      .mockResolvedValueOnce([]) // critical certs
      .mockResolvedValueOnce([]); // warning certs

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(5);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Marked expired station certificates');
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Marked expired CA certificates');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not log expiry counts when no certs are expired', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([]) // no expired station certs
      .mockResolvedValueOnce([]) // no expired CA certs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Marked expired station certificates',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Marked expired CA certificates');
  });

  it('publishes a TriggerMessage auto-renewal command per critical cert', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'sc_a',
          station_id: 'sta_a',
          certificate_type: 'V2GCertificate',
          valid_to: new Date('2026-06-10T00:00:00Z'),
          station_ocpp_id: 'CS-A',
        },
        {
          id: 'sc_b',
          station_id: 'sta_b',
          certificate_type: 'V2GCertificate',
          valid_to: new Date('2026-06-11T00:00:00Z'),
          station_ocpp_id: 'CS-B',
        },
      ])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenNthCalledWith(
      1,
      'ocpp_commands',
      JSON.stringify({
        commandId: 'fixed-uuid',
        stationId: 'CS-A',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignChargingStationCertificate' },
      }),
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      2,
      'ocpp_commands',
      JSON.stringify({
        commandId: 'fixed-uuid',
        stationId: 'CS-B',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignChargingStationCertificate' },
      }),
    );
  });

  it('publishes a certificate.expiring SSE event per warning cert and logs the count', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // no critical certs
      .mockResolvedValueOnce([
        { station_id: 'sta_1', station_ocpp_id: 'CS-1', site_id: 'site_1' },
        { station_id: 'sta_2', station_ocpp_id: 'CS-2', site_id: null },
      ]);

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenNthCalledWith(
      1,
      'csms_events',
      JSON.stringify({
        eventType: 'certificate.expiring',
        stationId: 'sta_1',
        siteId: 'site_1',
        sessionId: null,
      }),
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      2,
      'csms_events',
      JSON.stringify({
        eventType: 'certificate.expiring',
        stationId: 'sta_2',
        siteId: null,
        sessionId: null,
      }),
    );
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Notified for certs in warning window');
  });

  it('does not log the warning-window message when no warning certs exist', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);

    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Notified for certs in warning window',
    );
  });

  it('uses provided numeric critical/warning day thresholds in the query interpolations', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true, { criticalDays: 3, warningDays: 14 }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const before = Date.now();
    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);
    const after = Date.now();

    // 4th client call is the critical-certs SELECT. Its single interpolation is
    // the critical threshold: now + 3 days.
    const criticalCall = mockClient.mock.calls[3]!;
    const criticalThreshold = criticalCall[1] as Date;
    expect(criticalThreshold).toBeInstanceOf(Date);
    expect(criticalThreshold.getTime()).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(criticalThreshold.getTime()).toBeLessThanOrEqual(after + 3 * 86_400_000);

    // 5th client call is the warning-certs SELECT. Interpolations are
    // [warningThreshold (now + 14d), criticalThreshold (now + 3d)].
    const warningCall = mockClient.mock.calls[4]!;
    const warningThreshold = warningCall[1] as Date;
    const warningCritical = warningCall[2] as Date;
    expect(warningThreshold.getTime()).toBeGreaterThanOrEqual(before + 14 * 86_400_000);
    expect(warningThreshold.getTime()).toBeLessThanOrEqual(after + 14 * 86_400_000);
    expect(warningCritical.getTime()).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(warningCritical.getTime()).toBeLessThanOrEqual(after + 3 * 86_400_000);
  });

  it('falls back to default 7/30 day thresholds when settings are non-numeric', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true, { criticalDays: 'oops', warningDays: null }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const before = Date.now();
    const { certificateExpirationCheckHandler } =
      await import('../../handlers/certificate-expiration-check.js');
    await certificateExpirationCheckHandler(log);
    const after = Date.now();

    const criticalThreshold = mockClient.mock.calls[3]![1] as Date;
    const warningThreshold = mockClient.mock.calls[4]![1] as Date;
    expect(criticalThreshold.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(criticalThreshold.getTime()).toBeLessThanOrEqual(after + 7 * 86_400_000);
    expect(warningThreshold.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(warningThreshold.getTime()).toBeLessThanOrEqual(after + 30 * 86_400_000);
  });
});
