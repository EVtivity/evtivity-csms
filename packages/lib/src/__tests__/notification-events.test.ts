// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DRIVER_EVENT_TYPES,
  OCPP_NOTIFICATION_EVENTS,
  OCPP_NOTIFICATION_EVENT_TYPES,
  REQUIRED_DRIVER_EVENT_TYPES,
  isDriverEventType,
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

describe('required driver events', () => {
  it('always sends the notice of a session an Autocharge vehicle started', () => {
    expect(isRequiredDriverEventType('session.AutochargeStarted')).toBe(true);
    expect(isRequiredDriverEventType('session.Started')).toBe(false);
  });
});

describe('driver events', () => {
  it('lists every driver event once', () => {
    expect(new Set(DRIVER_EVENT_TYPES).size).toBe(DRIVER_EVENT_TYPES.length);
  });

  it('holds every required type', () => {
    for (const eventType of REQUIRED_DRIVER_EVENT_TYPES) {
      expect(isDriverEventType(eventType), eventType).toBe(true);
    }
  });

  it('refuses system, operator and OCPP event types', () => {
    expect(isDriverEventType('session.Started')).toBe(true);
    expect(isDriverEventType('session.EndRequestFailed')).toBe(false);
    expect(isDriverEventType('operator.ForgotPassword')).toBe(false);
    expect(isDriverEventType('invoice.FleetInvoice')).toBe(false);
    for (const eventType of OCPP_NOTIFICATION_EVENT_TYPES) {
      expect(isDriverEventType(eventType)).toBe(false);
    }
  });

  it('always sends the security notices of a changed password or removed MFA', () => {
    expect(isRequiredDriverEventType('driver.PasswordChanged')).toBe(true);
    expect(isRequiredDriverEventType('driver.MfaDisabled')).toBe(true);
  });
});
