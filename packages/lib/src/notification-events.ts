// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Browser-safe: imported by the CSMS through `@evtivity/lib/notification-events`.

/**
 * Every notification event sent to drivers. Matches the groups on the CSMS Driver
 * Events tab. Only these have an operator on/off switch (`driver_event_settings`):
 * the API refuses a switch for any other type and dispatch ignores a stored row for
 * one, so a system event can never be turned off there.
 */
export const DRIVER_EVENT_TYPES = [
  'session.Started',
  'session.AutochargeStarted',
  'session.Updated',
  'session.Completed',
  'session.Faulted',
  'session.PaymentReceived',
  'session.IdlingStarted',
  'session.Receipt',
  'driver.Welcome',
  'driver.ForgotPassword',
  'driver.PasswordChanged',
  'driver.AccountVerification',
  'driver.MfaDisabled',
  'driver.PortalInvite',
  'driver.RegistrationAttempt',
  'payment.Complete',
  'payment.Refunded',
  'payment.FeeRefunded',
  'payment.PreAuthFailed',
  'payment.CaptureFailed',
  'payment.MissingPaymentMethod',
  'payment.AccountCreditLimit',
  'reservation.Created',
  'reservation.Cancelled',
  'reservation.CancelledForMaintenance',
  'reservation.Expiring',
  'reservation.Expired',
  'reservation.StationFaulted',
  'reservation.TakenByOther',
  'invoice.Sent',
  'invoice.CreditNote',
  'invoice.MemberInvoice',
  'invoice.MemberCreditNote',
  'invoice.MemberOverdue',
  'supportCase.Created',
  'supportCase.OperatorReply',
  'supportCase.Resolved',
  'supportCase.AiAnswered',
  'mfa.VerificationCode',
  'token.Added',
  'token.Removed',
  'token.Deactivated',
  'token.Reactivated',
  'maintenance.SessionStopped',
  'watch.StationAvailable',
  'prepaid.LowCredit',
  'prepaid.CreditExhausted',
  'fleet.AccountBillingChanged',
] as const;

export type DriverEventType = (typeof DRIVER_EVENT_TYPES)[number];

const DRIVER_EVENTS = new Set<string>(DRIVER_EVENT_TYPES);

/** True for a driver notification event type (one with a Driver Events switch). */
export function isDriverEventType(eventType: string): eventType is DriverEventType {
  return DRIVER_EVENTS.has(eventType);
}

/**
 * Driver notification event types that are always on: what a driver needs to get into
 * their account (password reset, MFA codes, email verification, the portal invitation,
 * the notice that someone tried to register with their address), the security notices
 * of a changed password or removed MFA, the member invoice documents a fleet bills them
 * with (invoice, credit note, overdue reminder), and the notice of a session an
 * Autocharge vehicle started. The API refuses to turn them off, dispatch ignores a
 * stored disabled setting, and a recipient's own notification preferences do not
 * suppress them.
 */
export const REQUIRED_DRIVER_EVENT_TYPES = [
  'driver.ForgotPassword',
  'driver.AccountVerification',
  'driver.PortalInvite',
  'driver.RegistrationAttempt',
  // Security notices: the driver must learn of a change they may not have made
  // (owner rules, v0.1.46 hardening).
  'driver.PasswordChanged',
  'driver.MfaDisabled',
  'mfa.VerificationCode',
  'invoice.MemberInvoice',
  'invoice.MemberCreditNote',
  'invoice.MemberOverdue',
  // A start the driver may not have made (Autocharge): owner decision 2026-10-14.
  'session.AutochargeStarted',
] as const satisfies readonly DriverEventType[];

const REQUIRED = new Set<string>(REQUIRED_DRIVER_EVENT_TYPES);

export function isRequiredDriverEventType(eventType: string): boolean {
  return REQUIRED.has(eventType);
}

/**
 * Account security notices (system events, always on): sent to operators and drivers
 * when a sign-in method, recovery codes, the phone or email of the account change, an
 * operator creates an API key, the SSO settings change (to every all-site user who
 * may change them), an operator creates an admin-equivalent user or grants
 * permissions, an administrator resends a password setup link, or the retention of
 * the audit, sign-in or security event history is shortened (to every all-site user
 * who may change it), or the payment terminal settings change (to every all-site user
 * who may change them). They hold no secret.
 */
export const SECURITY_NOTICE_EVENT_TYPES = [
  'security.FactorAdded',
  'security.FactorRemoved',
  'security.RecoveryCodesRegenerated',
  'security.RecoveryCodeUsed',
  'security.PhoneChanged',
  'security.EmailChanged',
  'security.ApiKeyCreated',
  'security.SsoSettingsChanged',
  'security.UserCreatedPrivileged',
  'security.PermissionsGranted',
  'security.PasswordResetByAdmin',
  'security.SsoUnlinked',
  'security.RetentionLowered',
  'security.PaymentTerminalSettingsChanged',
] as const;

export type SecurityNoticeEventType = (typeof SECURITY_NOTICE_EVENT_TYPES)[number];

/** The secret variables of a security template: account links and one-time codes. */
export interface SecurityTemplateSecrets {
  /** Server-built links (password reset, invitation, verification, onboarding). */
  readonly links: readonly string[];
  /** One-time codes (MFA, phone and email codes). */
  readonly codes: readonly string[];
}

const NO_SECRETS: SecurityTemplateSecrets = { links: [], codes: [] };

/**
 * Security templates: every event that
 * carries an account link or a sign-in code, plus the notices that tell an account
 * holder about a security change. Editing one needs `settings.system:write` and
 * access to every site; a saved one keeps its links and codes as the server builds
 * them and links only to the CSMS or portal; dispatch falls back to the shipped
 * file for a stored one that breaks those rules. Payout onboarding is here because
 * its link connects a bank account that receives a site's payouts.
 */
export const SECURITY_TEMPLATE_EVENTS: Readonly<Record<string, SecurityTemplateSecrets>> = {
  'operator.ForgotPassword': { links: ['resetUrl'], codes: [] },
  'operator.UserCreated': { links: ['setPasswordUrl'], codes: [] },
  'operator.PasswordChanged': NO_SECRETS,
  'driver.ForgotPassword': { links: ['resetUrl'], codes: [] },
  'driver.AccountVerification': { links: ['verifyUrl'], codes: [] },
  'driver.PortalInvite': { links: ['activateUrl'], codes: [] },
  'driver.RegistrationAttempt': { links: ['signInUrl', 'resetUrl'], codes: [] },
  'driver.PasswordChanged': NO_SECRETS,
  'driver.MfaDisabled': NO_SECRETS,
  'mfa.VerificationCode': { links: [], codes: ['code'] },
  'site.PayoutOnboarding': { links: ['onboardingUrl'], codes: [] },
  ...Object.fromEntries(SECURITY_NOTICE_EVENT_TYPES.map((type) => [type, NO_SECRETS])),
};

/** True for a security template event type (see `SECURITY_TEMPLATE_EVENTS`). */
export function isSecurityTemplateEventType(eventType: string): boolean {
  return Object.hasOwn(SECURITY_TEMPLATE_EVENTS, eventType);
}

/**
 * Protocol versions whose stations emit an OCPP notification event: `common` for OCPP 1.6,
 * 2.0.1 and 2.1, `1.6` for OCPP 1.6 only, `2.x` for OCPP 2.0.1 and 2.1, `2.1` for OCPP 2.1
 * only (a message `isOcpp21OnlyMessage` names). OCPP 1.6 stations send the security and
 * Plug and Charge messages of the 1.6 Security Whitepaper and the 1.6 PnC DataTransfer
 * (SecurityEventNotification, LogStatusNotification, SignCertificate, Get15118EVCertificate,
 * GetCertificateStatus), which the 2.x handlers answer and publish under the same event.
 */
export type OcppNotificationVersion = 'common' | '1.6' | '2.x' | '2.1';

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
  'ocpp.Get15118EVCertificate': 'common',
  'ocpp.GetCertificateStatus': 'common',
  'ocpp.Heartbeat': 'common',
  'ocpp.LogStatusNotification': 'common',
  'ocpp.MessageLog': 'common',
  'ocpp.MeterValues': 'common',
  'ocpp.SecurityEventNotification': 'common',
  'ocpp.SignCertificate': 'common',
  'ocpp.StatusNotification': 'common',
  'ocpp.TransactionEvent': 'common',
  'ocpp.DiagnosticsStatus': '1.6',
  'ocpp.ClearedChargingLimit': '2.x',
  'ocpp.NotifyChargingLimit': '2.x',
  'ocpp.NotifyCustomerInformation': '2.x',
  'ocpp.NotifyDisplayMessages': '2.x',
  'ocpp.NotifyEVChargingNeeds': '2.x',
  'ocpp.NotifyEVChargingSchedule': '2.x',
  'ocpp.NotifyEvent': '2.x',
  'ocpp.NotifyMonitoringReport': '2.x',
  'ocpp.NotifyReport': '2.x',
  'ocpp.PublishFirmwareStatusNotification': '2.x',
  'ocpp.ReportChargingProfiles': '2.x',
  'ocpp.ReservationStatusUpdate': '2.x',
  'ocpp.BatterySwap': '2.1',
  'ocpp.GetCertificateChainStatus': '2.1',
  'ocpp.NotifyAllowedEnergyTransfer': '2.1',
  'ocpp.NotifyDERAlarm': '2.1',
  'ocpp.NotifyDERStartStop': '2.1',
  'ocpp.NotifyPeriodicEventStream': '2.1',
  'ocpp.NotifyPriorityCharging': '2.1',
  'ocpp.NotifySettlement': '2.1',
  'ocpp.PullDynamicScheduleUpdate': '2.1',
  'ocpp.ReportDERControl': '2.1',
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
