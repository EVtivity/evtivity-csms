// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// `client` is the postgres tagged-template fn. Each tagged-template call in the
// handler invokes mockClient(stringsArray, ...interpolations). Results are
// queued in call order: settings SELECT, expired-station UPDATE, expired-CA
// UPDATE, critical-certs SELECT, warning-certs SELECT.
const mockClient = vi.fn();
const mockWriteAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => mockClient(...args),
  certificateAuditLog: 'certificate_audit_log',
  writeAudit: (...args: unknown[]) => mockWriteAudit(...args) as unknown,
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

// publishOcppCommand (@evtivity/lib) draws the command id from node:crypto.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomUUID = () => 'fixed-uuid' as const;
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

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

// The module is imported after the mocks above are initialized. The first import loads the
// whole module graph, which under coverage on a busy machine took longer than one test's
// 5 s timeout, so it happens once here with its own timeout instead of inside the first test.
let mod: typeof import('../../handlers/certificate-expiration-check.js');
beforeAll(async () => {
  mod = await import('../../handlers/certificate-expiration-check.js');
}, 30_000);

describe('certificateExpirationCheckHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.mockReset();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
  });

  it('checks station TLS certificates only when PnC is disabled', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(false))
      .mockResolvedValueOnce([{ id: 'sc_1', certificate_type: 'ChargingStationCertificate' }])
      .mockResolvedValueOnce([
        {
          id: 'sc_2',
          station_id: 'sta_2',
          certificate_type: 'ChargingStationCertificate',
          valid_to: new Date('2026-06-10T00:00:00Z'),
          station_ocpp_id: 'CS-2',
          ocpp_protocol: 'ocpp2.1',
        },
      ])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    // Settings, expired station certificates, critical, warning: no CA UPDATE.
    expect(mockClient).toHaveBeenCalledTimes(4);
    const texts = mockClient.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts.some((t) => t.includes('UPDATE pki_ca_certificates'))).toBe(false);
    // Each station query limits itself to the TLS certificate while PnC is off.
    for (const i of [1, 2, 3]) {
      expect(texts[i]).toContain('? OR');
      expect(texts[i]).toMatch(/certificate_type = 'ChargingStationCertificate'/);
      expect(mockClient.mock.calls[i]).toContain(false);
    }
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockPublish.mock.calls[0]?.[1] as string)).toMatchObject({
      stationId: 'CS-2',
      action: 'TriggerMessage',
      payload: { requestedMessage: 'SignChargingStationCertificate' },
    });
  });

  it('treats a missing pnc.enabled as disabled', async () => {
    mockClient.mockResolvedValue([]);

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(4);
    expect(mockClient.mock.calls[1]).toContain(false);
    mockClient.mockReset();
  });

  it('marks expired station and CA certs and logs counts', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([{ id: 'sc_1' }, { id: 'sc_2' }]) // expired station certs
      .mockResolvedValueOnce([{ id: 'ca_1' }]) // expired CA certs
      .mockResolvedValueOnce([]) // critical certs
      .mockResolvedValueOnce([]); // warning certs

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    expect(mockClient).toHaveBeenCalledTimes(5);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Marked expired station certificates');
    expect(log.info).toHaveBeenCalledWith({ count: 1 }, 'Marked expired CA certificates');
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledTimes(3);
  });

  it('audits each certificate it marked expired as a system row, without the body', async () => {
    const validTo = new Date('2026-10-01T00:00:00.000Z');
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([
        {
          id: 11,
          station_id: 'sta_1',
          certificate_type: 'V2GCertificate',
          serial_number: 'AB01',
          valid_to: validTo,
        },
      ])
      .mockResolvedValueOnce([
        { id: 3, certificate_type: 'CSMSRootCertificate', serial_number: null, valid_to: validTo },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await mod.certificateExpirationCheckHandler(log);

    expect(mockWriteAudit).toHaveBeenNthCalledWith(
      1,
      { table: 'certificate_audit_log', idColumn: 'certificate_id' },
      {
        entityId: '11',
        entityIdSnapshot: '11',
        action: 'expired',
        actor: 'system',
        actorLabel: 'certificate-expiration-check',
        before: { status: 'active' },
        after: {
          status: 'expired',
          table: 'station_certificates',
          certificateType: 'V2GCertificate',
          serialNumber: 'AB01',
          validTo: '2026-10-01T00:00:00.000Z',
          stationId: 'sta_1',
        },
      },
      undefined,
      log,
    );
    expect(mockWriteAudit.mock.calls[1]?.[1]).toMatchObject({
      entityId: '3',
      action: 'expired',
      after: { table: 'pki_ca_certificates', certificateType: 'CSMSRootCertificate' },
    });
    expect(mockWriteAudit.mock.calls[1]?.[1]).not.toHaveProperty('after.stationId');
  });

  it('does not log expiry counts when no certs are expired', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([]) // no expired station certs
      .mockResolvedValueOnce([]) // no expired CA certs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Marked expired station certificates',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Marked expired CA certificates');
  });

  it('triggers the renewal message of each certificate type and protocol', async () => {
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
          ocpp_protocol: 'ocpp2.1',
        },
        {
          id: 'sc_b',
          station_id: 'sta_b',
          certificate_type: 'ChargingStationCertificate',
          valid_to: new Date('2026-06-11T00:00:00Z'),
          station_ocpp_id: 'CS-B',
          ocpp_protocol: 'ocpp2.1',
        },
        {
          id: 'sc_c',
          station_id: 'sta_c',
          certificate_type: 'V2G20Certificate',
          valid_to: new Date('2026-06-11T00:00:00Z'),
          station_ocpp_id: 'CS-C',
          ocpp_protocol: 'ocpp2.1',
        },
        {
          id: 'sc_d',
          station_id: 'sta_d',
          certificate_type: 'ChargingStationCertificate',
          valid_to: new Date('2026-06-12T00:00:00Z'),
          station_ocpp_id: 'CS-D',
          ocpp_protocol: 'ocpp1.6',
        },
        {
          id: 'sc_e',
          station_id: 'sta_e',
          certificate_type: 'V2GCertificate',
          valid_to: new Date('2026-06-12T00:00:00Z'),
          station_ocpp_id: 'CS-E',
          ocpp_protocol: 'ocpp1.6',
        },
      ])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    const sent = mockPublish.mock.calls.map((c) => JSON.parse(c[1] as string) as unknown);
    expect(sent).toEqual([
      {
        commandId: 'fixed-uuid',
        stationId: 'CS-A',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignV2GCertificate' },
      },
      {
        commandId: 'fixed-uuid',
        stationId: 'CS-B',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignChargingStationCertificate' },
      },
      {
        commandId: 'fixed-uuid',
        stationId: 'CS-C',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignV2G20Certificate' },
      },
      {
        commandId: 'fixed-uuid',
        stationId: 'CS-D',
        action: 'ExtendedTriggerMessage',
        payload: { requestedMessage: 'SignChargePointCertificate' },
      },
      {
        commandId: 'fixed-uuid',
        stationId: 'CS-E',
        action: 'TriggerMessage',
        payload: { requestedMessage: 'SignV2GCertificate' },
      },
    ]);
  });

  it('renews only station-keyed certificates not already replaced or awaiting a CSR', async () => {
    mockClient
      .mockResolvedValueOnce(settingsRows(true))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { certificateExpirationCheckHandler } = mod;
    await certificateExpirationCheckHandler(log);

    const text = (mockClient.mock.calls[3]?.[0] as string[]).join('?');
    // Root certificates the CSMS installed are never "renewed" by a CSR.
    expect(text).toContain(
      "sc.certificate_type IN ('ChargingStationCertificate', 'V2GCertificate', 'V2G20Certificate')",
    );
    // V2G20Certificate (ISO 15118-20) is OCPP 2.1 only; 2.0.1 renews like 1.6.
    expect(text).toContain("(cs.ocpp_protocol = 'ocpp2.1'");
    expect(text).toContain(
      "cs.ocpp_protocol IN ('ocpp1.6', 'ocpp2.0.1')\n          AND sc.certificate_type IN ('ChargingStationCertificate', 'V2GCertificate'))",
    );
    // A newer certificate of the type replaced it.
    expect(text).toContain('n.valid_to > ?');
    // A renewal CSR is still open.
    expect(text).toContain("r.status IN ('pending', 'submitted')");
    expect(text).toContain('DISTINCT ON (sc.station_id, sc.certificate_type)');
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

    const { certificateExpirationCheckHandler } = mod;
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

    const { certificateExpirationCheckHandler } = mod;
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
    const { certificateExpirationCheckHandler } = mod;
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
    const { certificateExpirationCheckHandler } = mod;
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
