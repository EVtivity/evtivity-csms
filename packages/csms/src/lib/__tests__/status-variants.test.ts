// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  reservationStatusVariant,
  fleetReservationStatusVariant,
  sessionStatusVariant,
  simpleSessionStatusVariant,
  roamingSessionStatusVariant,
  paymentStatusVariant,
  eventTypeVariant,
  supportCaseStatusVariant,
  supportCasePriorityVariant,
  roamingPartnerStatusVariant,
  stationStatusVariant,
  stationStatusClassName,
  stationCardConnectorStatusVariant,
  connectorStatusVariant,
  httpMethodVariant,
  httpStatusVariant,
  workerStatusVariant,
  certificateStatusVariant,
  stationCertificateStatusVariant,
  reportStatusVariant,
  cdrPushStatusVariant,
  notificationStatusBadgeClass,
} from '../status-variants';

type Fn = (s: string) => string | undefined;

function table(name: string, fn: Fn, cases: Array<[string, string | undefined]>): void {
  describe(name, () => {
    it.each(cases)('%s -> %s', (input, expected) => {
      expect(fn(input)).toBe(expected);
    });
  });
}

table('reservationStatusVariant', reservationStatusVariant, [
  ['active', 'default'],
  ['scheduled', 'info'],
  ['in_use', 'success'],
  ['used', 'secondary'],
  ['cancelled', 'destructive'],
  ['expired', 'outline'],
  ['unknown', 'outline'],
]);

table('fleetReservationStatusVariant', fleetReservationStatusVariant, [
  ['active', 'success'],
  ['partial', 'warning'],
  ['cancelled', 'destructive'],
  ['expired', 'outline'],
  ['completed', 'secondary'],
  ['unknown', 'outline'],
]);

describe('sessionStatusVariant', () => {
  it.each([
    ['active', 'success'],
    ['completed', 'secondary'],
    ['faulted', 'destructive'],
    ['failed', 'destructive'],
    ['invalid', 'warning'],
    ['other', 'outline'],
  ])('%s -> %s', (status, expected) => {
    expect(sessionStatusVariant(status)).toBe(expected);
  });

  it('shows an idling active session as warning', () => {
    expect(sessionStatusVariant('active', true)).toBe('warning');
  });

  it('ignores the idling flag for a non-active session', () => {
    expect(sessionStatusVariant('completed', true)).toBe('secondary');
    expect(sessionStatusVariant('faulted', true)).toBe('destructive');
  });
});

table('simpleSessionStatusVariant', simpleSessionStatusVariant, [
  ['active', 'success'],
  ['completed', 'secondary'],
  ['failed', 'destructive'],
  ['pending', 'warning'],
  ['faulted', 'outline'],
]);

table('roamingSessionStatusVariant', roamingSessionStatusVariant, [
  ['ACTIVE', 'default'],
  ['COMPLETED', 'secondary'],
  ['INVALID', 'destructive'],
  ['active', 'outline'],
  ['PENDING', 'outline'],
]);

table('paymentStatusVariant', paymentStatusVariant, [
  ['captured', 'success'],
  ['failed', 'destructive'],
  ['pre_authorized', 'warning'],
  ['pending', 'warning'],
  ['cancelled', 'secondary'],
  ['refunded', 'outline'],
  ['partially_refunded', 'outline'],
  ['mystery', 'outline'],
]);

table('eventTypeVariant', eventTypeVariant, [
  ['started', 'default'],
  ['ended', 'secondary'],
  ['updated', 'outline'],
  ['other', 'outline'],
]);

table('supportCaseStatusVariant', supportCaseStatusVariant, [
  ['open', 'default'],
  ['in_progress', 'secondary'],
  ['waiting_on_driver', 'outline'],
  ['resolved', 'secondary'],
  ['closed', 'outline'],
  ['other', 'outline'],
]);

table('supportCasePriorityVariant', supportCasePriorityVariant, [
  ['urgent', 'destructive'],
  ['high', 'destructive'],
  ['medium', 'default'],
  ['low', 'outline'],
  ['other', 'outline'],
]);

table('roamingPartnerStatusVariant', roamingPartnerStatusVariant, [
  ['connected', 'default'],
  ['pending', 'secondary'],
  ['suspended', 'outline'],
  ['disconnected', 'destructive'],
  ['other', 'outline'],
]);

table('stationStatusVariant', stationStatusVariant, [
  ['available', 'default'],
  ['occupied', 'default'],
  ['finishing', 'default'],
  ['charging', 'success'],
  ['discharging', 'success'],
  ['preparing', 'info'],
  ['ev_connected', 'info'],
  ['suspended_ev', 'warning'],
  ['suspended_evse', 'warning'],
  ['idle', 'warning'],
  ['reserved', 'outline'],
  ['faulted', 'destructive'],
  ['unavailable', 'destructive'],
  ['other', 'outline'],
]);

describe('stationStatusClassName', () => {
  it('gives reserved an orange override', () => {
    expect(stationStatusClassName('reserved')).toContain('bg-orange-500');
  });

  it('gives finishing a violet override', () => {
    expect(stationStatusClassName('finishing')).toContain('bg-violet-500');
  });

  it('returns undefined when the variant already supplies the color', () => {
    expect(stationStatusClassName('available')).toBeUndefined();
    expect(stationStatusClassName('faulted')).toBeUndefined();
  });
});

table('stationCardConnectorStatusVariant', stationCardConnectorStatusVariant, [
  ['available', 'default'],
  ['occupied', 'secondary'],
  ['faulted', 'destructive'],
  ['charging', 'outline'],
]);

describe('connectorStatusVariant', () => {
  it('is warning only for an idling occupied connector', () => {
    expect(connectorStatusVariant('occupied', true)).toBe('warning');
  });

  it('is secondary otherwise', () => {
    expect(connectorStatusVariant('occupied', false)).toBe('secondary');
    expect(connectorStatusVariant('occupied')).toBe('secondary');
    expect(connectorStatusVariant('available', true)).toBe('secondary');
  });
});

table('httpMethodVariant', httpMethodVariant, [
  ['GET', 'default'],
  ['POST', 'success'],
  ['PATCH', 'warning'],
  ['PUT', 'warning'],
  ['DELETE', 'destructive'],
  ['OPTIONS', 'secondary'],
]);

describe('httpStatusVariant', () => {
  it.each([
    [100, 'secondary'],
    [199, 'secondary'],
    [200, 'success'],
    [299, 'success'],
    [301, 'secondary'],
    [399, 'secondary'],
    [400, 'warning'],
    [499, 'warning'],
    [500, 'destructive'],
    [503, 'destructive'],
  ])('%i -> %s', (code, expected) => {
    expect(httpStatusVariant(code)).toBe(expected);
  });
});

table('workerStatusVariant', workerStatusVariant, [
  ['completed', 'success'],
  ['failed', 'destructive'],
  ['started', 'warning'],
  ['queued', 'secondary'],
]);

table('certificateStatusVariant', certificateStatusVariant, [
  ['active', 'default'],
  ['expired', 'destructive'],
  ['rejected', 'destructive'],
  ['pending', 'secondary'],
  ['submitted', 'secondary'],
  ['revoked', 'outline'],
]);

table('stationCertificateStatusVariant', stationCertificateStatusVariant, [
  ['active', 'default'],
  ['expired', 'destructive'],
  ['pending', 'outline'],
]);

table('reportStatusVariant', reportStatusVariant, [
  ['completed', 'default'],
  ['pending', 'secondary'],
  ['generating', 'secondary'],
  ['failed', 'destructive'],
  ['other', 'outline'],
]);

table('cdrPushStatusVariant', cdrPushStatusVariant, [
  ['confirmed', 'default'],
  ['sent', 'secondary'],
  ['pending', 'outline'],
  ['failed', 'destructive'],
  ['other', 'outline'],
]);

describe('notificationStatusBadgeClass', () => {
  it('maps delivery states to their color classes', () => {
    expect(notificationStatusBadgeClass('sent')).toContain('bg-success');
    expect(notificationStatusBadgeClass('failed')).toContain('bg-destructive');
    expect(notificationStatusBadgeClass('pending')).toContain('bg-warning');
  });

  it('returns an empty class for an unknown state', () => {
    expect(notificationStatusBadgeClass('queued')).toBe('');
  });
});
