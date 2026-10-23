// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station simulator connects only to the OCPP server (security review
// 2026-10-22 AZ-L8): a ws or wss URL on the origin of one of its configured
// OCPP URLs, never another host with the station password or certificate.

import { describe, expect, it } from 'vitest';
import { isAllowedSimulatorTarget } from '../simulator-target.js';

const SERVERS = ['ws://ocpp:7103', 'wss://ocpp:8443', undefined, ''];

describe('isAllowedSimulatorTarget', () => {
  it.each(['ws://ocpp:7103', 'ws://ocpp:7103/', 'wss://ocpp:8443', 'WSS://OCPP:8443/'])(
    'accepts %s',
    (url) => {
      expect(isAllowedSimulatorTarget(url, SERVERS)).toBe(true);
    },
  );

  it.each([
    'ws://evil.example/',
    'wss://evil.example:8443',
    'ws://ocpp:7104',
    'http://ocpp:7103',
    'wss://ocpp:7103',
    'ws://user:pass@ocpp:7103',
    'ws://ocpp:7103/other-path',
    'ws://ocpp:7103/?x=1',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedSimulatorTarget(url, SERVERS)).toBe(false);
  });

  it('accepts the path of a server URL with a path, and no other path', () => {
    const servers = ['wss://csms.example.com/ocpp'];
    expect(isAllowedSimulatorTarget('wss://csms.example.com/ocpp/', servers)).toBe(true);
    expect(isAllowedSimulatorTarget('wss://csms.example.com/', servers)).toBe(false);
  });

  it('refuses everything when no server is configured', () => {
    expect(isAllowedSimulatorTarget('ws://ocpp:7103', [undefined, ''])).toBe(false);
  });
});
