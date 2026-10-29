// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ONENCE_MAX_FIELD_LENGTH,
  oneNceTimeToIso,
  pickEvent,
  pickEvents,
  pickQuota,
  pickSim,
  pickStatus,
  ratName,
} from '../fields.js';
import { mapOneNceState, oneNceProviderState } from '../states.js';

// The examples of the v2 spec schemas (SimsSim, SimsConnectivityDetail, SimsQuota, Event).
const SPEC_SIM = {
  iccid: '8988303000123456789',
  iccid_with_luhn: '89883030001234567890',
  imsi: '901405100000018',
  imsi_2: '901405100000018',
  current_imsi: '901405100000019',
  msisdn: '882285100000018',
  imei: '0000000000000018',
  imei_lock: true,
  status: 'Enabled',
  activation_date: '2018-03-09T07:59:09.000+0000',
  ip_address: '100.100.100.18',
  current_quota: 500,
  quota_status: {
    id: 1,
    description: 'Less than 20% available',
    threshold_reached_date: '2026-10-27T10:00:00.000Z',
    quota_exceeded_date: '2026-10-28T10:00:00.000Z',
  },
  current_quota_SMS: 250,
  label: 'DX-137-B12',
};

const SPEC_STATUS = {
  status: { description: 'ONLINE' },
  data_traffic_limit_state: { description: 'NOT_REACHED' },
  location: {
    iccid: '8988303010000000000',
    imsi: '901439999999999',
    sgsn_ip_address: '12.23.107.88',
    operator: { id: 2, name: 'T-Mobile', mnc: '01', country: { id: 74, name: 'Germany' } },
  },
  pdp_contexts: [
    {
      pdp_context_id: '92415',
      created: '2019-12-04T08:12:02.000Z',
      apn: 'iot.1nce.net',
      ue_ip_address: '10.0.0.1',
      imeisv: '3534770000000000',
      rat_type: { rat_type_id: '2', description: 'NB-IoT' },
    },
  ],
  services: ['GPRS'],
};

const SPEC_QUOTA = {
  id: 1,
  status: { id: 1, description: 'ACTIVE' },
  volume: 435.787951,
  total_volume: 500,
  accumulated_total_volume: 100,
  last_volume_added: 500,
  service: 'data',
  threshold_percentage: 20,
  expiry_date: '2029-01-01T00:00:00.000Z',
};

const SPEC_EVENT = {
  id: 12_345,
  event_type: { id: 4, description: 'Delete PDP Context' },
  timestamp: '2023-03-01T12:07:09.000Z',
  alert: true,
  description: 'PDP Context deleted.',
  event_source: { id: 0, description: 'Network' },
  event_severity: { id: 0, description: 'INFO' },
  organisation: { id: 2, name: 'Organisation_Name' },
  endpoint: { id: 1, name: 'Monitoring201', ip_address: '10.199.6.39', imei: '869951030000000' },
  sim: { id: 110, iccid: '8988317000000000000', msisdn: '456831700000000' },
  imsi: { id: 110, imsi: '901430000000114' },
  detail: {
    id: 2,
    name: 'Telekom',
    volume: { tx: 0.1, rx: 0.4, total: 0.5 },
    pdp_context: {
      pdp_context_id: 92_415,
      rat_type: 6,
      mcc: '262',
      mnc: '01',
      apn: 'iot.1nce.net',
      ue_ip_address: '10.0.0.1',
      imeisv: '3534770000000000',
      gtp_v2_uli: { tac: 1, eci: 123_456 },
      tunnel_created: '2023-03-01T11:07:09.000Z',
    },
  },
};

const FORBIDDEN_VALUES = [
  '0000000000000018',
  '869951030000000',
  '882285100000018',
  '456831700000000',
  '100.100.100.18',
  '10.199.6.39',
  '10.0.0.1',
  '12.23.107.88',
  'Monitoring201',
  'Organisation_Name',
  '3534770000000000',
];

function expectNoForbiddenValues(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_VALUES) expect(text).not.toContain(forbidden);
}

describe('1NCE field picking', () => {
  it('picks the SIM allow list only', () => {
    const sim = pickSim(SPEC_SIM);
    expect(sim).toEqual({
      iccid: '8988303000123456789',
      iccidWithLuhn: '89883030001234567890',
      imsi: '901405100000019',
      status: 'Enabled',
      thresholdReachedAt: '2026-10-27T10:00:00.000Z',
      quotaExceededAt: '2026-10-28T10:00:00.000Z',
    });
    expectNoForbiddenValues(sim);
    expect(pickSim([])).toBeNull();
    expect(pickSim({ ...SPEC_SIM, current_imsi: undefined })?.imsi).toBe('901405100000018');
  });

  it('picks the connectivity status and the open contexts', () => {
    const status = pickStatus(SPEC_STATUS);
    expect(status).toEqual({
      status: 'ONLINE',
      openContexts: [{ createdAt: '2019-12-04T08:12:02.000Z', apn: 'iot.1nce.net' }],
    });
    expectNoForbiddenValues(status);
    expect(pickStatus({ status: { description: 'OFFLINE' } })).toEqual({
      status: 'OFFLINE',
      openContexts: [],
    });
  });

  it('picks the data quota', () => {
    expect(pickQuota(SPEC_QUOTA)).toEqual({
      volume: 435.787951,
      totalVolume: 500,
      expiresAt: '2029-01-01T00:00:00.000Z',
      status: 'ACTIVE',
    });
    expect(pickQuota({ volume: 'many' })?.volume).toBeNull();
  });

  it('picks an event with a hashed device and no identifier', () => {
    const event = pickEvent(SPEC_EVENT);
    expect(event).toMatchObject({
      id: 12_345,
      typeId: 4,
      timestamp: '2023-03-01T12:07:09.000Z',
      pdpContextId: '92415',
      volumeTotal: 0.5,
      networkName: 'Telekom',
      ratType: 6,
      cellId: '123456',
      apn: 'iot.1nce.net',
      tunnelCreatedAt: '2023-03-01T11:07:09.000Z',
    });
    expect(event?.deviceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        'id',
        'typeId',
        'timestamp',
        'deviceHash',
        'pdpContextId',
        'volumeTotal',
        'networkName',
        'ratType',
        'cellId',
        'apn',
        'tunnelCreatedAt',
      ].sort(),
    );
    expectNoForbiddenValues(event);
  });

  it('reads the cell id from GTP v1 when there is no v2 location', () => {
    const event = pickEvent({
      ...SPEC_EVENT,
      detail: { pdp_context: { pdp_context_id: 1, gtp_v1_uli: { lac: 1, ci: 77 } } },
    });
    expect(event?.cellId).toBe('77');
    expect(event?.networkName).toBeNull();
  });

  it('drops an event without an id or a time, and a field over the limit', () => {
    expect(pickEvent({ ...SPEC_EVENT, id: 'x' })).toBeNull();
    expect(pickEvent({ ...SPEC_EVENT, timestamp: 'yesterday' })).toBeNull();
    const long = 'a'.repeat(ONENCE_MAX_FIELD_LENGTH + 1);
    const event = pickEvent({
      ...SPEC_EVENT,
      detail: { ...SPEC_EVENT.detail, name: long, pdp_context: { apn: long } },
    });
    expect(event?.networkName).toBeNull();
    expect(event?.apn).toBeNull();
    expect(pickSim({ ...SPEC_SIM, status: long })?.status).toBeNull();
  });

  it('reads a page of events and counts what it read', () => {
    expect(pickEvents([SPEC_EVENT, { id: 'bad' }, null])).toMatchObject({ read: 3 });
    expect(pickEvents([SPEC_EVENT]).events).toHaveLength(1);
    expect(pickEvents({ events: [] })).toEqual({ events: [], read: 0 });
  });

  it('reads the 1NCE time forms', () => {
    expect(oneNceTimeToIso('2018-03-09T07:59:09.000+0000')).toBe('2018-03-09T07:59:09.000Z');
    expect(oneNceTimeToIso('2023-08-06 09:59:05')).toBe('2023-08-06T09:59:05.000Z');
    expect(oneNceTimeToIso('2023-08-06T09:59:05+02:00')).toBe('2023-08-06T07:59:05.000Z');
    expect(oneNceTimeToIso('not a time')).toBeNull();
    expect(oneNceTimeToIso(1_700_000_000)).toBeNull();
  });

  it('names the RAT types of 3GPP TS 29.274', () => {
    expect([1, 2, 6, 8, 9, 10].map(ratName)).toEqual(['3G', '2G', '4G', 'NB-IoT', 'LTE-M', '5G']);
    expect(ratName(3)).toBeNull();
    expect(ratName(null)).toBeNull();
  });
});

describe('1NCE states', () => {
  it('maps Enabled, Disabled and the connectivity', () => {
    expect(mapOneNceState('Enabled', 'ONLINE')).toBe('active');
    expect(mapOneNceState('Enabled', 'OFFLINE')).toBe('active');
    expect(mapOneNceState('Enabled', null)).toBe('active');
    expect(mapOneNceState('Enabled', 'BLOCKED')).toBe('suspended');
    expect(mapOneNceState('Disabled', 'ONLINE')).toBe('suspended');
    expect(mapOneNceState('Gone', 'ONLINE')).toBe('unknown');
    expect(mapOneNceState(null, null)).toBe('unknown');
  });

  it('names the provider state with the connectivity in brackets', () => {
    expect(oneNceProviderState('Enabled', 'ONLINE')).toBe('Enabled (ONLINE)');
    expect(oneNceProviderState('Disabled', null)).toBe('Disabled');
    expect(oneNceProviderState(null, 'OFFLINE')).toBe('OFFLINE');
    expect(oneNceProviderState('Something else', 'WEIRD')).toBe('');
  });
});
