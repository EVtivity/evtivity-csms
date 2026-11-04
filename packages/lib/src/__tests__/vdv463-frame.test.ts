// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  parseVdv463Frame,
  vdv463ErrorFrame,
  vdv463ErrorText,
  vdv463Timestamp,
  writeVdv463Frame,
} from '../vdv463/index.js';

const ID = 'b1f6a4c2-6c1e-4a8e-9a55-2f1d3e0c7a10';
const AT = '2026-03-10T05:00:00Z';

function frame(items: unknown[]): string {
  return JSON.stringify(items);
}

describe('parseVdv463Frame', () => {
  it('reads a request of seven items', () => {
    const raw = frame([1, 'BMS', 'DMS-NORTH', AT, ID, 'BootNotification', { presystem: 'BMS' }]);
    expect(parseVdv463Frame(raw)).toEqual({
      ok: true,
      frame: {
        type: 1,
        source: 'BMS',
        presystemId: 'DMS-NORTH',
        timestamp: AT,
        messageId: ID,
        action: 'BootNotification',
        payload: { presystem: 'BMS' },
      },
    });
  });

  it('accepts a timestamp with an offset and a fraction', () => {
    const raw = frame([
      2,
      'BMS',
      'D',
      '2026-03-10T06:00:00.250+01:00',
      ID,
      'ProvideChargingInformation',
      {},
    ]);
    expect(parseVdv463Frame(raw).ok).toBe(true);
  });

  it.each([
    ['text that is not JSON', '{', 'invalid_json'],
    ['an object instead of an array', '{"a":1}', 'invalid_frame'],
    ['six items', frame([1, 'BMS', 'D', AT, ID, 'BootNotification']), 'invalid_frame'],
    ['eight items', frame([1, 'BMS', 'D', AT, ID, 'BootNotification', {}, 1]), 'invalid_frame'],
    [
      'the type as a string',
      frame(['1', 'BMS', 'D', AT, ID, 'BootNotification', {}]),
      'invalid_frame',
    ],
    ['type 4', frame([4, 'BMS', 'D', AT, ID, 'BootNotification', {}]), 'invalid_frame'],
    ['type 0', frame([0, 'BMS', 'D', AT, ID, 'BootNotification', {}]), 'invalid_frame'],
    [
      'a message id that is no UUID',
      frame([1, 'BMS', 'D', AT, '42', 'BootNotification', {}]),
      'invalid_frame',
    ],
    [
      'a timestamp without a zone',
      frame([1, 'BMS', 'D', '2026-03-10T05:00:00', ID, 'BootNotification', {}]),
      'invalid_frame',
    ],
    [
      'an impossible date',
      frame([1, 'BMS', 'D', '2026-13-40T05:00:00Z', ID, 'BootNotification', {}]),
      'invalid_frame',
    ],
    [
      'a numeric presystem id',
      frame([1, 'BMS', 7, AT, ID, 'BootNotification', {}]),
      'invalid_frame',
    ],
    ['an unknown action', frame([1, 'BMS', 'D', AT, ID, 'Heartbeat', {}]), 'unknown_action'],
    ['a payload array', frame([1, 'BMS', 'D', AT, ID, 'BootNotification', []]), 'invalid_frame'],
    ['a null payload', frame([1, 'BMS', 'D', AT, ID, 'BootNotification', null]), 'invalid_frame'],
    [
      'a string payload on a request',
      frame([1, 'BMS', 'D', AT, ID, 'BootNotification', 'x']),
      'invalid_frame',
    ],
  ])('refuses %s', (_name, raw, reason) => {
    expect(parseVdv463Frame(raw)).toMatchObject({ ok: false, reason });
  });

  it('keeps what it could read of a refused frame', () => {
    expect(parseVdv463Frame(frame([1, 'BMS', 'D', AT, ID, 'BootNotification', []]))).toMatchObject({
      ok: false,
      messageId: ID,
      action: 'BootNotification',
      presystemId: 'D',
      type: 1,
    });
  });

  it('keeps no message id that is not a UUID and no unknown action (OCPP-I3)', () => {
    const refused = parseVdv463Frame(frame([1, 'BMS', 'D', AT, 'x'.repeat(5000), 'Heartbeat', {}]));
    expect(refused.ok).toBe(false);
    expect(refused).not.toHaveProperty('messageId');
    expect(refused).not.toHaveProperty('action');
    const unknown = parseVdv463Frame(frame([1, 'BMS', 'D', AT, ID, 'Heartbeat', {}]));
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown_action', messageId: ID });
    expect(unknown).not.toHaveProperty('action');
  });

  it('accepts an error payload as a string or an object', () => {
    expect(
      parseVdv463Frame(frame([3, 'BMS', 'D', AT, ID, 'ProvideChargingInformation', 'bad'])).ok,
    ).toBe(true);
    expect(
      parseVdv463Frame(
        frame([3, 'BMS', 'D', AT, ID, 'ProvideChargingInformation', { errorMessage: 'bad' }]),
      ).ok,
    ).toBe(true);
  });
});

describe('writing frames', () => {
  it('writes UTC with Z and whole seconds', () => {
    expect(vdv463Timestamp(new Date('2026-03-10T06:00:00.987+01:00'))).toBe('2026-03-10T05:00:00Z');
  });

  it('writes seven items with CMS as the source', () => {
    const out = JSON.parse(
      writeVdv463Frame({
        type: 2,
        presystemId: 'D',
        timestamp: new Date(AT),
        messageId: ID,
        action: 'BootNotification',
        payload: { status: 'Accepted' },
      }),
    ) as unknown[];
    expect(out).toEqual([2, 'CMS', 'D', AT, ID, 'BootNotification', { status: 'Accepted' }]);
  });

  it('writes the error payload as an errorMessage object', () => {
    const out = JSON.parse(
      vdv463ErrorFrame('D', ID, 'Heartbeat', 'Unknown message action', new Date(AT)),
    ) as unknown[];
    expect(out[0]).toBe(3);
    expect(out[6]).toEqual({ errorMessage: 'Unknown message action' });
  });

  it('reads the error text of a string or an object payload', () => {
    expect(vdv463ErrorText('plain')).toBe('plain');
    expect(vdv463ErrorText({ errorMessage: 'object' })).toBe('object');
    expect(vdv463ErrorText({ other: 1 })).toBe('');
  });
});
