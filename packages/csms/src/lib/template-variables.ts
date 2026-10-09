// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  OCPP_NOTIFICATION_EVENT_TYPES,
  ocppNotificationEventsFor,
} from '@evtivity/lib/notification-events';

export interface TemplateVariable {
  name: string;
  description: string;
}

// OCPP events, from the shared list the OCPP server subscribes and the API lists.
// Common to OCPP 1.6 and 2.1:
export const OCPP_COMMON_EVENTS = ocppNotificationEventsFor('common');

// OCPP 1.6 only:
export const OCPP_16_EVENTS = ocppNotificationEventsFor('1.6');

// OCPP 2.1 only:
export const OCPP_21_EVENTS = ocppNotificationEventsFor('2.1');

// All OCPP event types
export const OCPP_EVENT_TYPES = OCPP_NOTIFICATION_EVENT_TYPES;

// Driver-facing events: notifications sent to drivers
export const DRIVER_SESSION_EVENTS = [
  'session.Started',
  'session.Updated',
  'session.Completed',
  'session.Faulted',
  'session.PaymentReceived',
  'session.IdlingStarted',
  'session.Receipt',
] as const;

export const DRIVER_MAINTENANCE_EVENTS = ['maintenance.SessionStopped'] as const;

export const DRIVER_ACCOUNT_EVENTS = [
  'driver.Welcome',
  'driver.ForgotPassword',
  'driver.PasswordChanged',
  'driver.AccountVerification',
  'driver.MfaDisabled',
  'driver.PortalInvite',
] as const;

/** Driver events sent by email only. The verification link proves the email address, so it never goes to an unverified phone. */
export const EMAIL_ONLY_DRIVER_EVENTS: readonly string[] = ['driver.AccountVerification'];

export const DRIVER_PAYMENT_EVENTS = [
  'payment.Complete',
  'payment.Refunded',
  'payment.FeeRefunded',
  'payment.PreAuthFailed',
  'payment.CaptureFailed',
  'payment.MissingPaymentMethod',
  'payment.AccountCreditLimit',
] as const;

export const DRIVER_RESERVATION_EVENTS = [
  'reservation.Created',
  'reservation.Cancelled',
  'reservation.CancelledForMaintenance',
  'reservation.Expiring',
  'reservation.Expired',
  'reservation.StationFaulted',
] as const;

export const DRIVER_SUPPORT_EVENTS = [
  'supportCase.Created',
  'supportCase.OperatorReply',
  'supportCase.Resolved',
] as const;

export const DRIVER_TOKEN_EVENTS = [
  'token.Added',
  'token.Removed',
  'token.Deactivated',
  'token.Reactivated',
] as const;

export const DRIVER_MFA_EVENTS = ['mfa.VerificationCode'] as const;

export const DRIVER_INVOICE_EVENTS = ['invoice.Sent', 'invoice.CreditNote'] as const;

export const DRIVER_WATCH_EVENTS = ['watch.StationAvailable'] as const;

export const DRIVER_PREPAID_EVENTS = ['prepaid.LowCredit', 'prepaid.CreditExhausted'] as const;

export const DRIVER_FLEET_EVENTS = ['fleet.AccountBillingChanged'] as const;

// All driver-facing event types (for backward compat)
export const DRIVER_EVENT_TYPES = [
  ...DRIVER_SESSION_EVENTS,
  ...DRIVER_ACCOUNT_EVENTS,
  ...DRIVER_PAYMENT_EVENTS,
  ...DRIVER_RESERVATION_EVENTS,
  ...DRIVER_SUPPORT_EVENTS,
  ...DRIVER_TOKEN_EVENTS,
  ...DRIVER_MFA_EVENTS,
  ...DRIVER_MAINTENANCE_EVENTS,
  ...DRIVER_INVOICE_EVENTS,
  ...DRIVER_WATCH_EVENTS,
  ...DRIVER_PREPAID_EVENTS,
  ...DRIVER_FLEET_EVENTS,
] as const;

// Keep old names for imports that haven't been updated
export const SYSTEM_EVENT_TYPES = DRIVER_ACCOUNT_EVENTS;
export const MFA_EVENT_TYPES = DRIVER_MFA_EVENTS;

// System/operator-facing events: notifications sent to operators/admins
export const OPERATOR_ACCOUNT_EVENTS = [
  'operator.UserCreated',
  'operator.ForgotPassword',
  'operator.PasswordChanged',
] as const;

export const OPERATOR_SUPPORT_EVENTS = [
  'supportCase.NewCaseFromDriver',
  'supportCase.DriverReply',
] as const;

// Session alerts: sent to operators who manage the session's site
export const OPERATOR_SESSION_EVENTS = ['session.EndRequestFailed'] as const;

// Site host events: notifications sent to a site's contact
export const SITE_HOST_EVENTS = ['site.PayoutOnboarding'] as const;

// Fleet billing alerts: sent to a fleet's billing contacts and the operators who manage fleets
export const FLEET_BILLING_SYSTEM_EVENTS = [
  'fleet.CreditLimitWarning',
  'fleet.CreditLimitReached',
  'fleet.InvoiceRunFailed',
] as const;

// Fleet invoices: emailed with the PDF to a fleet's billing contacts
export const FLEET_INVOICE_EVENTS = [
  'invoice.FleetInvoice',
  'invoice.FleetCreditNote',
  'invoice.FleetOverdue',
] as const;

export const OPERATOR_EVENT_TYPES = [
  ...OPERATOR_ACCOUNT_EVENTS,
  ...OPERATOR_SUPPORT_EVENTS,
  ...OPERATOR_SESSION_EVENTS,
  ...SITE_HOST_EVENTS,
  ...FLEET_BILLING_SYSTEM_EVENTS,
  ...FLEET_INVOICE_EVENTS,
] as const;

export const COMMON_VARIABLES: TemplateVariable[] = [
  { name: 'companyName', description: 'Company name' },
  { name: 'companyCurrency', description: 'Platform currency code (e.g. USD)' },
  { name: 'companyContactEmail', description: 'Contact email' },
  { name: 'companySupportEmail', description: 'Support email' },
  { name: 'companySupportPhone', description: 'Support phone' },
  { name: 'companyStreet', description: 'Street address' },
  { name: 'companyCity', description: 'City' },
  { name: 'companyState', description: 'State or province' },
  { name: 'companyZip', description: 'ZIP or postal code' },
  { name: 'companyCountry', description: 'Country' },
];

export const TEMPLATE_VARIABLES: Record<string, TemplateVariable[]> = {
  'station.Connected': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'station.Disconnected': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.Authorize': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.BatterySwap': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.BootNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'firmwareVersion', description: 'Firmware version' },
    { name: 'model', description: 'Station model' },
    { name: 'serialNumber', description: 'Serial number' },
  ],
  'ocpp.ClearedChargingLimit': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.DataTransfer': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.FirmwareStatusNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'status', description: 'Firmware update status' },
  ],
  'ocpp.DiagnosticsStatus': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'status', description: 'Diagnostics upload status' },
  ],
  'ocpp.Get15118EVCertificate': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.GetCertificateChainStatus': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.GetCertificateStatus': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.Heartbeat': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.LogStatusNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.MeterValues': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'evseId', description: 'EVSE ID' },
  ],
  'ocpp.MessageLog': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyAllowedEnergyTransfer': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyChargingLimit': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyCustomerInformation': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyDERAlarm': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyDERStartStop': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyDisplayMessages': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyEVChargingNeeds': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyEVChargingSchedule': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyEvent': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyMonitoringReport': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyPeriodicEventStream': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyPriorityCharging': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifyReport': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.NotifySettlement': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.PublishFirmwareStatusNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'status', description: 'Firmware update status' },
  ],
  'ocpp.PullDynamicScheduleUpdate': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.ReportChargingProfiles': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.ReportDERControl': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.ReservationStatusUpdate': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.SecurityEventNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'type', description: 'Security event type' },
  ],
  'ocpp.SignCertificate': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'ocpp.StatusNotification': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'connectorStatus', description: 'Connector status' },
    { name: 'evseId', description: 'EVSE ID' },
    { name: 'connectorId', description: 'Connector ID' },
    { name: 'isFaulted', description: 'Whether the connector is faulted' },
  ],
  'ocpp.TransactionEvent': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'evseId', description: 'EVSE ID' },
  ],
  'ocpp.VatNumberValidation': [
    { name: 'stationId', description: 'Station identifier' },
    { name: 'occurredAt', description: 'Timestamp' },
  ],
  'session.Started': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'startedAt', description: 'Start timestamp' },
  ],
  'session.Updated': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'energyDeliveredWh', description: 'Energy in Wh' },
    { name: 'currentCostCents', description: 'Current cost in cents' },
    { name: 'costFormatted', description: 'Cost with currency, including tax' },
    {
      name: 'costIncludesTax',
      description: 'Whether the cost contains tax (a tariff tax rate applied); use with #if',
    },
    { name: 'currency', description: 'Currency code' },
    { name: 'durationMinutes', description: 'Duration in minutes' },
  ],
  'session.Completed': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'energyDeliveredWh', description: 'Energy in Wh' },
    { name: 'finalCostCents', description: 'Final cost in cents' },
    { name: 'costFormatted', description: 'Cost with currency, including tax' },
    {
      name: 'costIncludesTax',
      description: 'Whether the cost contains tax (a tariff tax rate applied); use with #if',
    },
    { name: 'currency', description: 'Currency code' },
    { name: 'durationMinutes', description: 'Duration in minutes' },
    { name: 'startedAt', description: 'Start timestamp' },
    { name: 'endedAt', description: 'End timestamp' },
    {
      name: 'notCharged',
      description:
        'Nothing was charged: the cost is below the payment provider minimum and the hold was released; use with #if',
    },
    {
      name: 'billingMode',
      description:
        'How the session is paid: account (billed to a fleet), card, or empty (prepaid, roaming, free vend)',
    },
    {
      name: 'billedTo',
      description:
        'Fleet the session is billed to, no card charged (charge on account); empty otherwise, use with #if',
    },
  ],
  'session.Faulted': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'reason', description: 'Failure reason' },
  ],
  'session.PaymentReceived': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    {
      name: 'amountFormatted',
      description: 'Amount with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'amountCents', description: 'Payment amount in cents' },
    { name: 'currency', description: 'Currency code' },
  ],
  'session.IdlingStarted': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'idleStartedAt', description: 'When idling started' },
    { name: 'gracePeriodMinutes', description: 'Grace period in minutes' },
    { name: 'idleFeePricePerMinute', description: 'Idle fee rate per minute, excluding tax' },
    {
      name: 'idleFeeFormatted',
      description:
        'Idle fee per minute with currency, including or excluding tax as the driver chose; empty without an idle fee',
    },
    { name: 'idleFeeIncludesTax', description: 'Whether idleFeeFormatted includes tax' },
    { name: 'taxRatePercent', description: 'Tariff tax rate in percent; empty without tax' },
    { name: 'currency', description: 'Currency code' },
  ],
  'driver.Welcome': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
  ],
  'driver.ForgotPassword': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'resetUrl', description: 'Password reset URL' },
  ],
  'driver.PortalInvite': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'activateUrl', description: 'Link to set the portal password' },
    { name: 'expiresInDays', description: 'Days until the link expires' },
  ],
  'driver.PasswordChanged': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
  ],
  'driver.MfaDisabled': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
  ],
  'driver.AccountVerification': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'verifyUrl', description: 'Email verification URL' },
  ],
  'payment.Complete': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    {
      name: 'amountFormatted',
      description: 'Amount with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'amountCents', description: 'Payment amount in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'transactionId', description: 'Transaction ID' },
  ],
  'payment.Refunded': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    {
      name: 'amountFormatted',
      description: 'Refund amount with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'amountCents', description: 'Refund amount in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'transactionId', description: 'Session ID' },
  ],
  'payment.FeeRefunded': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    {
      name: 'amountFormatted',
      description: 'Refund amount with currency, in the driver language (e.g. $5.95)',
    },
    { name: 'amountCents', description: 'Refund amount in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'feeType', description: 'Refunded fee: cancellation or no_show' },
    { name: 'isNoShowFee', description: 'True for a no-show fee, false for a cancellation fee' },
    {
      name: 'reservationId',
      description: 'Reservation ID (empty when the reservation was deleted)',
    },
    { name: 'refundedAt', description: 'Refund date and time' },
  ],
  'payment.PreAuthFailed': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'reason', description: 'Failure reason' },
  ],
  'payment.CaptureFailed': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    {
      name: 'amountFormatted',
      description: 'Amount with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'reason', description: 'Failure reason' },
  ],
  'payment.MissingPaymentMethod': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
  ],
  'payment.AccountCreditLimit': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'fleetName', description: 'Fleet the session is billed to' },
    { name: 'siteName', description: 'Site name (empty when the station has no site)' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
  ],
  'reservation.Created': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'reservationId', description: 'Reservation ID' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    { name: 'expiresAt', description: 'Expiration timestamp' },
  ],
  'reservation.Cancelled': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'reservationId', description: 'Reservation ID' },
    { name: 'stationId', description: 'Station OCPP identifier' },
    {
      name: 'cancellationFeeFormatted',
      description:
        'Cancellation fee charged, tax included, with currency in the driver language (e.g. $5.95); empty without a fee',
    },
    {
      name: 'cancellationFeeCents',
      description: 'Cancellation fee charged in cents, tax included',
    },
    { name: 'currency', description: 'Currency code' },
  ],
  'reservation.CancelledForMaintenance': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'maintenanceEventId', description: 'Maintenance event ID' },
    { name: 'plannedStartAt', description: 'Planned maintenance start' },
    { name: 'plannedEndAt', description: 'Planned maintenance end' },
    { name: 'reason', description: 'Operator-supplied reason' },
  ],
  'maintenance.SessionStopped': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'maintenanceEventId', description: 'Maintenance event ID' },
    { name: 'sessionId', description: 'Charging session ID that was stopped' },
    { name: 'plannedEndAt', description: 'When maintenance is expected to end' },
    { name: 'reason', description: 'Operator-supplied reason' },
  ],
  'reservation.Expiring': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'reservationId', description: 'Reservation ID' },
    { name: 'expiresAt', description: 'Expiration timestamp' },
  ],
  'reservation.Expired': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'reservationId', description: 'Reservation ID' },
  ],
  'reservation.StationFaulted': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'reservationId', description: 'Reservation ID' },
    { name: 'stationId', description: 'Station OCPP identifier' },
  ],
  'session.Receipt': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'siteName', description: 'Site name' },
    { name: 'transactionId', description: 'Transaction ID' },
    { name: 'energyDeliveredWh', description: 'Energy in Wh' },
    { name: 'finalCostCents', description: 'Final cost in cents' },
    { name: 'costFormatted', description: 'Cost with currency, including tax' },
    {
      name: 'costIncludesTax',
      description: 'Whether the cost contains tax (a tariff tax rate applied); use with #if',
    },
    { name: 'currency', description: 'Currency code' },
    { name: 'durationMinutes', description: 'Duration in minutes' },
    { name: 'startedAt', description: 'Start timestamp' },
    { name: 'endedAt', description: 'End timestamp' },
    {
      name: 'notCharged',
      description:
        'Nothing was charged: the cost is below the payment provider minimum and the hold was released; use with #if',
    },
    {
      name: 'billingMode',
      description:
        'How the session is paid: account (billed to a fleet), card, or empty (prepaid, roaming, free vend)',
    },
    {
      name: 'billedTo',
      description:
        'Fleet the session is billed to, no card charged (charge on account); empty otherwise, use with #if',
    },
  ],
  'invoice.Sent': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'invoiceNumber', description: 'Invoice number' },
    { name: 'status', description: 'Invoice status' },
    { name: 'issuedAt', description: 'Issued timestamp' },
    { name: 'dueAt', description: 'Due timestamp' },
    {
      name: 'total',
      description: 'Invoice total with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'totalCents', description: 'Invoice total in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'companyName', description: 'Company name' },
  ],
  'invoice.CreditNote': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'creditNoteNumber', description: 'Credit note number (CN-YYYYMM-NNNN)' },
    { name: 'invoiceNumber', description: 'Number of the invoice the credit note cancels' },
    { name: 'creditReason', description: 'Reason the operator gave for the credit note' },
    { name: 'issuedAt', description: 'Issued timestamp of the credit note' },
    {
      name: 'total',
      description: 'Amount credited with currency, in the driver language (e.g. $12.50)',
    },
    { name: 'totalCents', description: 'Amount credited in cents' },
    { name: 'currency', description: 'Currency code' },
    {
      name: 'wasPaid',
      description:
        'The cancelled invoice was already paid; the refund is made separately. Use with #if',
    },
    { name: 'companyName', description: 'Company name' },
  ],
  'watch.StationAvailable': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'stationName', description: 'Station name or OCPP identifier' },
    { name: 'siteName', description: 'Site name' },
    { name: 'stationId', description: 'Station OCPP identifier' },
  ],
  'supportCase.Created': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'caseNumber', description: 'Support case number' },
    { name: 'subject', description: 'Case subject' },
    { name: 'category', description: 'Case category' },
  ],
  'supportCase.OperatorReply': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'caseNumber', description: 'Support case number' },
    { name: 'subject', description: 'Case subject' },
    { name: 'category', description: 'Case category' },
  ],
  'supportCase.Resolved': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'caseNumber', description: 'Support case number' },
    { name: 'subject', description: 'Case subject' },
    { name: 'category', description: 'Case category' },
  ],
  'mfa.VerificationCode': [
    { name: 'code', description: 'Six-digit verification code' },
    { name: 'firstName', description: 'Recipient first name' },
    { name: 'email', description: 'Recipient email address' },
  ],
  'prepaid.LowCredit': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Prepaid card identifier (e.g. RFID UID)' },
    {
      name: 'balanceFormatted',
      description: 'Balance after the debit, with currency, in the driver language (e.g. $3.50)',
    },
    { name: 'balanceCents', description: 'Balance after the debit in cents' },
    {
      name: 'thresholdFormatted',
      description: 'Low credit threshold with currency, in the driver language (e.g. $5.00)',
    },
    { name: 'currency', description: 'Currency code' },
  ],
  'fleet.AccountBillingChanged': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'fleetName', description: 'Fleet whose account billing or membership changed' },
    {
      name: 'billedTo',
      description:
        'Fleet the driver sessions are now billed to; empty when they pay by card, use with #if',
    },
    {
      name: 'accountBilling',
      description: 'Whether the driver sessions are now billed to a fleet; use with #if',
    },
  ],
  'prepaid.CreditExhausted': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Prepaid card identifier (e.g. RFID UID)' },
    { name: 'siteName', description: 'Site name (empty when the station has no site)' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'transactionId', description: 'Transaction ID' },
    {
      name: 'creditFormatted',
      description:
        'Prepaid credit the session used up, with currency, in the driver language (e.g. $25.00)',
    },
    { name: 'currency', description: 'Currency code' },
  ],
  'token.Added': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Token identifier (e.g. RFID UID)' },
    { name: 'tokenType', description: 'OCPP token type (e.g. ISO14443)' },
    { name: 'addedBy', description: 'Who added the token (driver, operator, system)' },
  ],
  'token.Removed': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Token identifier (e.g. RFID UID)' },
    { name: 'tokenType', description: 'OCPP token type (e.g. ISO14443)' },
    { name: 'removedBy', description: 'Who removed the token (driver, operator, system)' },
  ],
  'token.Deactivated': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Token identifier (e.g. RFID UID)' },
    { name: 'tokenType', description: 'OCPP token type (e.g. ISO14443)' },
    { name: 'reason', description: 'Optional reason supplied by the operator' },
  ],
  'token.Reactivated': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'idToken', description: 'Token identifier (e.g. RFID UID)' },
    { name: 'tokenType', description: 'OCPP token type (e.g. ISO14443)' },
    { name: 'reactivatedBy', description: 'Who reactivated (driver, operator, system)' },
  ],
  'session.EndRequestFailed': [
    { name: 'firstName', description: 'Operator first name' },
    { name: 'lastName', description: 'Operator last name' },
    { name: 'email', description: 'Operator email address' },
    { name: 'sessionId', description: 'Session ID (search for it on the Sessions page)' },
    { name: 'stationId', description: 'Station identifier' },
    { name: 'siteName', description: 'Site name (empty when the station has no site)' },
    { name: 'transactionId', description: 'Transaction ID' },
    {
      name: 'endRequestReason',
      description: 'Why the CSMS ended the session (Superseded, GhostRecovered)',
    },
    { name: 'attempts', description: 'Number of failed end attempts' },
    { name: 'startedAt', description: 'Session start time' },
    { name: 'endedAt', description: 'Time the session was faulted' },
  ],
  'fleet.CreditLimitWarning': [
    { name: 'firstName', description: 'Operator first name (empty for a billing contact)' },
    { name: 'lastName', description: 'Operator last name (empty for a billing contact)' },
    { name: 'fleetName', description: 'Fleet name' },
    {
      name: 'exposureFormatted',
      description:
        'Open amount on account (unbilled, invoiced unpaid and running sessions) with currency',
    },
    { name: 'limitFormatted', description: 'Credit limit with currency' },
    { name: 'exposureCents', description: 'Open amount on account in cents' },
    { name: 'limitCents', description: 'Credit limit in cents' },
    { name: 'warningPercent', description: 'Warning percent of the credit limit (e.g. 80)' },
    { name: 'currency', description: 'Currency code' },
  ],
  'fleet.CreditLimitReached': [
    { name: 'firstName', description: 'Operator first name (empty for a billing contact)' },
    { name: 'lastName', description: 'Operator last name (empty for a billing contact)' },
    { name: 'fleetName', description: 'Fleet name' },
    {
      name: 'exposureFormatted',
      description:
        'Open amount on account (unbilled, invoiced unpaid and running sessions) with currency',
    },
    { name: 'limitFormatted', description: 'Credit limit with currency' },
    { name: 'exposureCents', description: 'Open amount on account in cents' },
    { name: 'limitCents', description: 'Credit limit in cents' },
    { name: 'warningPercent', description: 'Warning percent of the credit limit (e.g. 80)' },
    { name: 'currency', description: 'Currency code' },
  ],
  'invoice.FleetInvoice': [
    { name: 'fleetName', description: 'Fleet name' },
    { name: 'invoiceNumber', description: 'Invoice number (INV-YYYYMM-NNNN)' },
    {
      name: 'periodLabel',
      description: 'Billed month in the fleet invoice language (e.g. September 2026)',
    },
    { name: 'sessionCount', description: 'Number of charging sessions on the invoice' },
    { name: 'issuedAt', description: 'Issued timestamp' },
    { name: 'dueAt', description: 'Due timestamp' },
    { name: 'total', description: 'Invoice total with currency (e.g. $412.50)' },
    { name: 'totalCents', description: 'Invoice total in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'companyName', description: 'Company name' },
  ],
  'invoice.FleetCreditNote': [
    { name: 'fleetName', description: 'Fleet name' },
    { name: 'creditNoteNumber', description: 'Credit note number (CN-YYYYMM-NNNN)' },
    { name: 'invoiceNumber', description: 'Number of the fleet invoice the credit note cancels' },
    {
      name: 'periodLabel',
      description: 'Billed month in the fleet invoice language (e.g. September 2026)',
    },
    { name: 'creditReason', description: 'Reason the operator gave for the credit note' },
    { name: 'issuedAt', description: 'Issued timestamp of the credit note' },
    { name: 'total', description: 'Amount credited with currency (e.g. $412.50)' },
    { name: 'totalCents', description: 'Amount credited in cents' },
    { name: 'currency', description: 'Currency code' },
    {
      name: 'wasPaid',
      description:
        'The cancelled invoice was already paid; the refund is made separately. Use with #if',
    },
    { name: 'companyName', description: 'Company name' },
  ],
  'invoice.FleetOverdue': [
    { name: 'fleetName', description: 'Fleet name' },
    { name: 'invoiceNumber', description: 'Number of the overdue invoice (INV-YYYYMM-NNNN)' },
    {
      name: 'periodLabel',
      description: 'Billed month in the fleet invoice language (e.g. September 2026)',
    },
    { name: 'sessionCount', description: 'Number of charging sessions on the invoice' },
    { name: 'issuedAt', description: 'Issued timestamp' },
    { name: 'dueAt', description: 'Due timestamp (passed)' },
    { name: 'total', description: 'Amount due with currency (e.g. $412.50)' },
    { name: 'totalCents', description: 'Amount due in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'companyName', description: 'Company name' },
  ],
  'fleet.InvoiceRunFailed': [
    { name: 'firstName', description: 'Operator first name' },
    { name: 'lastName', description: 'Operator last name' },
    { name: 'period', description: 'Month the run could not invoice (YYYY-MM)' },
    { name: 'fleetCount', description: 'Number of fleets in this notice' },
    { name: 'fleetNames', description: 'Names of the fleets in this notice, comma-separated' },
    {
      name: 'issuedNotEmailed',
      description:
        'Fleets whose invoice was issued but not emailed: "Fleet (invoice number): last error", separated by "; " (empty when none)',
    },
    { name: 'issuedNotEmailedCount', description: 'Number of fleets issued but not emailed' },
    {
      name: 'notInvoiced',
      description: 'Fleets not invoiced: "Fleet: last error", separated by "; " (empty when none)',
    },
    { name: 'notInvoicedCount', description: 'Number of fleets not invoiced' },
    { name: 'companyName', description: 'Company name' },
  ],
  'site.PayoutOnboarding': [
    { name: 'siteName', description: 'Site name' },
    { name: 'contactName', description: 'Site contact name' },
    { name: 'email', description: 'Site contact email address' },
    { name: 'onboardingUrl', description: 'Link to set up the Stripe payout account' },
    { name: 'expiresInDays', description: 'Days until the link expires' },
  ],
  'operator.UserCreated': [
    { name: 'firstName', description: 'User first name' },
    { name: 'lastName', description: 'User last name' },
    { name: 'email', description: 'User email address' },
    { name: 'setPasswordUrl', description: 'URL to set the account password (expires in 24h)' },
  ],
  'operator.ForgotPassword': [
    { name: 'firstName', description: 'User first name' },
    { name: 'lastName', description: 'User last name' },
    { name: 'email', description: 'User email address' },
    { name: 'resetUrl', description: 'Password reset URL' },
  ],
  'operator.PasswordChanged': [
    { name: 'firstName', description: 'User first name' },
    { name: 'lastName', description: 'User last name' },
    { name: 'email', description: 'User email address' },
  ],
};
