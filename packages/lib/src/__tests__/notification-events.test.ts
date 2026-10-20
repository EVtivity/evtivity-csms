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
import { isOcpp21OnlyMessage } from '../ocpp-version.js';

describe('OCPP notification events', () => {
  it('lists every event once, in the order of the map', () => {
    expect(OCPP_NOTIFICATION_EVENT_TYPES).toEqual(Object.keys(OCPP_NOTIFICATION_EVENTS));
    expect(new Set(OCPP_NOTIFICATION_EVENT_TYPES).size).toBe(OCPP_NOTIFICATION_EVENT_TYPES.length);
  });

  it('splits the list into the common, OCPP 1.6, OCPP 2.x and OCPP 2.1 groups', () => {
    const common = ocppNotificationEventsFor('common');
    const v16 = ocppNotificationEventsFor('1.6');
    const v2x = ocppNotificationEventsFor('2.x');
    const v21 = ocppNotificationEventsFor('2.1');
    expect(common).toContain('ocpp.BootNotification');
    expect(common).toContain('station.Connected');
    expect(v2x).toContain('ocpp.NotifyReport');
    expect(v21).toContain('ocpp.NotifyDERAlarm');
    expect(v16).toEqual(['ocpp.DiagnosticsStatus']);
    expect([...common, ...v16, ...v2x, ...v21].sort()).toEqual(
      [...OCPP_NOTIFICATION_EVENT_TYPES].sort(),
    );
  });

  it('puts an event in the OCPP 2.1 group only when OCPP 2.0.1 lacks its message', () => {
    for (const eventType of OCPP_NOTIFICATION_EVENT_TYPES) {
      if (!eventType.startsWith('ocpp.')) continue;
      const action = eventType.slice('ocpp.'.length);
      expect(OCPP_NOTIFICATION_EVENTS[eventType] === '2.1', eventType).toBe(
        isOcpp21OnlyMessage(action),
      );
    }
  });

  it('lists the messages OCPP 1.6 stations send through the Security Whitepaper and PnC as common', () => {
    for (const eventType of [
      'ocpp.SecurityEventNotification',
      'ocpp.LogStatusNotification',
      'ocpp.SignCertificate',
      'ocpp.Get15118EVCertificate',
      'ocpp.GetCertificateStatus',
    ] as const) {
      expect(OCPP_NOTIFICATION_EVENTS[eventType], eventType).toBe('common');
    }
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
