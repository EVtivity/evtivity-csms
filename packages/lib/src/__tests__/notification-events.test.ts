// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  OCPP_NOTIFICATION_EVENTS,
  OCPP_NOTIFICATION_EVENT_TYPES,
  isRequiredDriverEventType,
  ocppNotificationEventsFor,
} from '../notification-events.js';

describe('OCPP notification events', () => {
  it('lists every event once, in the order of the map', () => {
    expect(OCPP_NOTIFICATION_EVENT_TYPES).toEqual(Object.keys(OCPP_NOTIFICATION_EVENTS));
    expect(new Set(OCPP_NOTIFICATION_EVENT_TYPES).size).toBe(OCPP_NOTIFICATION_EVENT_TYPES.length);
  });

  it('splits the list into the common, OCPP 1.6 and OCPP 2.1 groups', () => {
    const common = ocppNotificationEventsFor('common');
    const v16 = ocppNotificationEventsFor('1.6');
    const v21 = ocppNotificationEventsFor('2.1');
    expect(common).toContain('ocpp.BootNotification');
    expect(common).toContain('station.Connected');
    expect(v21).toContain('ocpp.NotifyReport');
    expect(v21).not.toContain('ocpp.BootNotification');
    expect(v16).toEqual(['ocpp.DiagnosticsStatus']);
    expect([...common, ...v16, ...v21].sort()).toEqual([...OCPP_NOTIFICATION_EVENT_TYPES].sort());
  });

  it('holds only station and ocpp events', () => {
    for (const eventType of OCPP_NOTIFICATION_EVENT_TYPES) {
      expect(eventType).toMatch(/^(station|ocpp)\.[A-Z][A-Za-z0-9]+$/);
      expect(isRequiredDriverEventType(eventType)).toBe(false);
    }
  });
});
