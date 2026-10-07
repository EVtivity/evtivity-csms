// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Browser-safe: imported by the CSMS through `@evtivity/lib/notification-events`.

/**
 * Driver notification event types a driver needs to get into their account: password
 * reset, MFA codes, email verification and the portal invitation. They are always on.
 * The API refuses to turn them off, dispatch ignores a stored disabled setting, and
 * a recipient's own notification preferences do not suppress them.
 */
export const REQUIRED_DRIVER_EVENT_TYPES = [
  'driver.ForgotPassword',
  'driver.AccountVerification',
  'driver.PortalInvite',
  'mfa.VerificationCode',
] as const;

const REQUIRED = new Set<string>(REQUIRED_DRIVER_EVENT_TYPES);

export function isRequiredDriverEventType(eventType: string): boolean {
  return REQUIRED.has(eventType);
}

/**
 * Protocol versions whose stations emit an OCPP notification event: `common` for OCPP 1.6
 * and 2.1, `1.6` for OCPP 1.6 only, `2.1` for OCPP 2.1 only.
 */
export type OcppNotificationVersion = 'common' | '1.6' | '2.1';

/**
 * Every OCPP operator notification event and the OCPP versions that emit it. The single
 * source for the OCPP server's notification subscriptions, the API event type list and
 * the CSMS OCPP Events groups. Each event has default templates in
 * `packages/ocpp/src/templates/{lang}/ocpp/<Action>/` (or `station/<Name>/`). An event
 * sends nothing until an operator enables it: no `ocpp_event_settings` row means off.
 */
export const OCPP_NOTIFICATION_EVENTS = {
  'station.Connected': 'common',
  'station.Disconnected': 'common',
  'ocpp.Authorize': 'common',
  'ocpp.BootNotification': 'common',
  'ocpp.DataTransfer': 'common',
  'ocpp.FirmwareStatusNotification': 'common',
  'ocpp.Heartbeat': 'common',
  'ocpp.MessageLog': 'common',
  'ocpp.MeterValues': 'common',
  'ocpp.StatusNotification': 'common',
  'ocpp.TransactionEvent': 'common',
  'ocpp.DiagnosticsStatus': '1.6',
  'ocpp.BatterySwap': '2.1',
  'ocpp.ClearedChargingLimit': '2.1',
  'ocpp.Get15118EVCertificate': '2.1',
  'ocpp.GetCertificateChainStatus': '2.1',
  'ocpp.GetCertificateStatus': '2.1',
  'ocpp.LogStatusNotification': '2.1',
  'ocpp.NotifyAllowedEnergyTransfer': '2.1',
  'ocpp.NotifyChargingLimit': '2.1',
  'ocpp.NotifyCustomerInformation': '2.1',
  'ocpp.NotifyDERAlarm': '2.1',
  'ocpp.NotifyDERStartStop': '2.1',
  'ocpp.NotifyDisplayMessages': '2.1',
  'ocpp.NotifyEVChargingNeeds': '2.1',
  'ocpp.NotifyEVChargingSchedule': '2.1',
  'ocpp.NotifyEvent': '2.1',
  'ocpp.NotifyMonitoringReport': '2.1',
  'ocpp.NotifyPeriodicEventStream': '2.1',
  'ocpp.NotifyPriorityCharging': '2.1',
  'ocpp.NotifyReport': '2.1',
  'ocpp.NotifySettlement': '2.1',
  'ocpp.PublishFirmwareStatusNotification': '2.1',
  'ocpp.PullDynamicScheduleUpdate': '2.1',
  'ocpp.ReportChargingProfiles': '2.1',
  'ocpp.ReportDERControl': '2.1',
  'ocpp.ReservationStatusUpdate': '2.1',
  'ocpp.SecurityEventNotification': '2.1',
  'ocpp.SignCertificate': '2.1',
  'ocpp.VatNumberValidation': '2.1',
} as const satisfies Record<string, OcppNotificationVersion>;

export type OcppNotificationEventType = keyof typeof OCPP_NOTIFICATION_EVENTS;

/** All OCPP notification event types, in list order. */
export const OCPP_NOTIFICATION_EVENT_TYPES = Object.keys(
  OCPP_NOTIFICATION_EVENTS,
) as OcppNotificationEventType[];

/** OCPP notification event types emitted by stations of one version group. */
export function ocppNotificationEventsFor(
  version: OcppNotificationVersion,
): OcppNotificationEventType[] {
  return OCPP_NOTIFICATION_EVENT_TYPES.filter(
    (eventType) => OCPP_NOTIFICATION_EVENTS[eventType] === version,
  );
}
