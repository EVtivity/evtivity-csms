// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface TemplateVariable {
  name: string;
  description: string;
}

// Common OCPP events (both 1.6 and 2.1)
export const OCPP_COMMON_EVENTS = [
  'station.Connected',
  'station.Disconnected',
  'ocpp.Authorize',
  'ocpp.BootNotification',
  'ocpp.DataTransfer',
  'ocpp.FirmwareStatusNotification',
  'ocpp.Heartbeat',
  'ocpp.MeterValues',
  'ocpp.StatusNotification',
  'ocpp.TransactionEvent',
] as const;

// OCPP 2.1 only events
export const OCPP_21_EVENTS = [
  'ocpp.BatterySwap',
  'ocpp.ClearedChargingLimit',
  'ocpp.Get15118EVCertificate',
  'ocpp.GetCertificateChainStatus',
  'ocpp.GetCertificateStatus',
  'ocpp.LogStatusNotification',
  'ocpp.MessageLog',
  'ocpp.NotifyAllowedEnergyTransfer',
  'ocpp.NotifyChargingLimit',
  'ocpp.NotifyCustomerInformation',
  'ocpp.NotifyDERAlarm',
  'ocpp.NotifyDERStartStop',
  'ocpp.NotifyDisplayMessages',
  'ocpp.NotifyEVChargingNeeds',
  'ocpp.NotifyEVChargingSchedule',
  'ocpp.NotifyEvent',
  'ocpp.NotifyMonitoringReport',
  'ocpp.NotifyPeriodicEventStream',
  'ocpp.NotifyPriorityCharging',
  'ocpp.NotifyQRCodeScanned',
  'ocpp.NotifyReport',
  'ocpp.NotifySettlement',
  'ocpp.NotifyWebPaymentStarted',
  'ocpp.PublishFirmwareStatusNotification',
  'ocpp.PullDynamicScheduleUpdate',
  'ocpp.ReportChargingProfiles',
  'ocpp.ReportDERControl',
  'ocpp.ReservationStatusUpdate',
  'ocpp.SecurityEventNotification',
  'ocpp.SignCertificate',
  'ocpp.VatNumberValidation',
] as const;

// All OCPP event types
export const OCPP_EVENT_TYPES = [...OCPP_COMMON_EVENTS, ...OCPP_21_EVENTS] as const;

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

export const DRIVER_ACCOUNT_EVENTS = [
  'driver.Welcome',
  'driver.ForgotPassword',
  'driver.PasswordChanged',
  'driver.AccountVerification',
] as const;

export const DRIVER_PAYMENT_EVENTS = [
  'payment.Complete',
  'payment.Refunded',
  'payment.PreAuthFailed',
  'payment.CaptureFailed',
  'payment.MissingPaymentMethod',
] as const;

export const DRIVER_RESERVATION_EVENTS = [
  'reservation.Created',
  'reservation.Cancelled',
  'reservation.Expiring',
  'reservation.Expired',
  'reservation.StationFaulted',
] as const;

export const DRIVER_SUPPORT_EVENTS = [
  'supportCase.Created',
  'supportCase.OperatorReply',
  'supportCase.Resolved',
] as const;

export const DRIVER_MFA_EVENTS = ['mfa.VerificationCode'] as const;

// All driver-facing event types (for backward compat)
export const DRIVER_EVENT_TYPES = [
  ...DRIVER_SESSION_EVENTS,
  ...DRIVER_ACCOUNT_EVENTS,
  ...DRIVER_PAYMENT_EVENTS,
  ...DRIVER_RESERVATION_EVENTS,
  ...DRIVER_SUPPORT_EVENTS,
  ...DRIVER_MFA_EVENTS,
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

export const OPERATOR_EVENT_TYPES = [
  ...OPERATOR_ACCOUNT_EVENTS,
  ...OPERATOR_SUPPORT_EVENTS,
] as const;

export const COMMON_VARIABLES: TemplateVariable[] = [
  { name: 'companyName', description: 'Company name' },
  { name: 'companyCurrency', description: 'Display currency code (e.g. USD)' },
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
  'ocpp.NotifyQRCodeScanned': [
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
  'ocpp.NotifyWebPaymentStarted': [
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
    { name: 'currency', description: 'Currency code' },
    { name: 'durationMinutes', description: 'Duration in minutes' },
    { name: 'startedAt', description: 'Start timestamp' },
    { name: 'endedAt', description: 'End timestamp' },
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
    { name: 'idleFeePricePerMinute', description: 'Idle fee rate per minute' },
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
  'driver.PasswordChanged': [
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
    { name: 'amountCents', description: 'Payment amount in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'transactionId', description: 'Transaction ID' },
  ],
  'payment.Refunded': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
    { name: 'email', description: 'Driver email address' },
    { name: 'amountCents', description: 'Refund amount in cents' },
    { name: 'currency', description: 'Currency code' },
    { name: 'transactionId', description: 'Session ID' },
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
    { name: 'amountFormatted', description: 'Formatted amount (e.g. $12.50)' },
    { name: 'reason', description: 'Failure reason' },
  ],
  'payment.MissingPaymentMethod': [
    { name: 'firstName', description: 'Driver first name' },
    { name: 'lastName', description: 'Driver last name' },
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
    { name: 'cancellationFeeFormatted', description: 'Formatted cancellation fee (e.g. $5.00)' },
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
    { name: 'currency', description: 'Currency code' },
    { name: 'durationMinutes', description: 'Duration in minutes' },
    { name: 'startedAt', description: 'Start timestamp' },
    { name: 'endedAt', description: 'End timestamp' },
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
