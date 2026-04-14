// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { MessageRouter } from '../server/message-router.js';
import { handleBootNotification } from './v2_1/boot-notification.handler.js';
import { handleHeartbeat } from './v2_1/heartbeat.handler.js';
import { handleStatusNotification } from './v2_1/status-notification.handler.js';
import { handleAuthorize } from './v2_1/authorize.handler.js';
import { handleTransactionEvent } from './v2_1/transaction-event.handler.js';
import { handleMeterValues } from './v2_1/meter-values.handler.js';
import { handleFirmwareStatusNotification } from './v2_1/firmware-status-notification.handler.js';
import { handleSecurityEventNotification } from './v2_1/security-event-notification.handler.js';
import { handleNotifyEvent } from './v2_1/notify-event.handler.js';
import { handleNotifyReport } from './v2_1/notify-report.handler.js';
import { handleLogStatusNotification } from './v2_1/log-status-notification.handler.js';
import { handleSignCertificate } from './v2_1/sign-certificate.handler.js';
import { handleDataTransfer } from './v2_1/data-transfer.handler.js';
import { handleReservationStatusUpdate } from './v2_1/reservation-status-update.handler.js';
import { handleClearedChargingLimit } from './v2_1/cleared-charging-limit.handler.js';
import { handleNotifyChargingLimit } from './v2_1/notify-charging-limit.handler.js';
import { handleNotifyEVChargingNeeds } from './v2_1/notify-ev-charging-needs.handler.js';
import { handleGetTransactionStatus } from './v2_1/get-transaction-status.handler.js';
import { handleGet15118EVCertificate } from './v2_1/get-15118-ev-certificate.handler.js';
import { handleGetCertificateStatus } from './v2_1/get-certificate-status.handler.js';
import { handleGetCertificateChainStatus } from './v2_1/get-certificate-chain-status.handler.js';
import { handleNotifyCustomerInformation } from './v2_1/notify-customer-information.handler.js';
import { handleNotifyDisplayMessages } from './v2_1/notify-display-messages.handler.js';
import { handleNotifyEVChargingSchedule } from './v2_1/notify-ev-charging-schedule.handler.js';
import { handleNotifyMonitoringReport } from './v2_1/notify-monitoring-report.handler.js';
import { handleNotifySettlement } from './v2_1/notify-settlement.handler.js';
import { handlePublishFirmwareStatusNotification } from './v2_1/publish-firmware-status-notification.handler.js';
import { handleReportChargingProfiles } from './v2_1/report-charging-profiles.handler.js';
import { handleNotifyPriorityCharging } from './v2_1/notify-priority-charging.handler.js';
import { handlePullDynamicScheduleUpdate } from './v2_1/pull-dynamic-schedule-update.handler.js';
import { handleBatterySwap } from './v2_1/battery-swap.handler.js';
import { handleNotifyPeriodicEventStream } from './v2_1/notify-periodic-event-stream.handler.js';
import { handleOpenPeriodicEventStream } from './v2_1/open-periodic-event-stream.handler.js';
import { handleClosePeriodicEventStream } from './v2_1/close-periodic-event-stream.handler.js';
import { handleNotifyQRCodeScanned } from './v2_1/notify-qr-code-scanned.handler.js';
import { handleVatNumberValidation } from './v2_1/vat-number-validation.handler.js';
import { handleNotifyAllowedEnergyTransfer } from './v2_1/notify-allowed-energy-transfer.handler.js';
import { handleNotifyDERAlarm } from './v2_1/notify-der-alarm.handler.js';
import { handleNotifyDERStartStop } from './v2_1/notify-der-start-stop.handler.js';
import { handleReportDERControl } from './v2_1/report-der-control.handler.js';
import { handleNotifyWebPaymentStarted } from './v2_1/notify-web-payment-started.handler.js';

// OCPP 1.6 handlers
import { handleBootNotification as handleBootNotification16 } from './v1_6/boot-notification.handler.js';
import { handleHeartbeat as handleHeartbeat16 } from './v1_6/heartbeat.handler.js';
import { handleAuthorize as handleAuthorize16 } from './v1_6/authorize.handler.js';
import { handleStartTransaction as handleStartTransaction16 } from './v1_6/start-transaction.handler.js';
import { handleStopTransaction as handleStopTransaction16 } from './v1_6/stop-transaction.handler.js';
import { handleStatusNotification as handleStatusNotification16 } from './v1_6/status-notification.handler.js';
import { handleMeterValues as handleMeterValues16 } from './v1_6/meter-values.handler.js';
import { handleDataTransfer as handleDataTransfer16 } from './v1_6/data-transfer.handler.js';
import { handleFirmwareStatusNotification as handleFirmwareStatus16 } from './v1_6/firmware-status-notification.handler.js';
import { handleDiagnosticsStatusNotification as handleDiagnosticsStatus16 } from './v1_6/diagnostics-status-notification.handler.js';

export function registerHandlers(router: MessageRouter): void {
  // ---- OCPP 2.1 handlers ----

  // Core lifecycle
  router.register('ocpp2.1', 'BootNotification', handleBootNotification);
  router.register('ocpp2.1', 'Heartbeat', handleHeartbeat);
  router.register('ocpp2.1', 'StatusNotification', handleStatusNotification);

  // Authorization and transactions
  router.register('ocpp2.1', 'Authorize', handleAuthorize);
  router.register('ocpp2.1', 'TransactionEvent', handleTransactionEvent);
  router.register('ocpp2.1', 'MeterValues', handleMeterValues);
  router.register('ocpp2.1', 'GetTransactionStatus', handleGetTransactionStatus);

  // Firmware and logging
  router.register('ocpp2.1', 'FirmwareStatusNotification', handleFirmwareStatusNotification);
  router.register('ocpp2.1', 'LogStatusNotification', handleLogStatusNotification);
  router.register(
    'ocpp2.1',
    'PublishFirmwareStatusNotification',
    handlePublishFirmwareStatusNotification,
  );

  // Security and certificates
  router.register('ocpp2.1', 'SecurityEventNotification', handleSecurityEventNotification);
  router.register('ocpp2.1', 'SignCertificate', handleSignCertificate);
  router.register('ocpp2.1', 'Get15118EVCertificate', handleGet15118EVCertificate);
  router.register('ocpp2.1', 'GetCertificateStatus', handleGetCertificateStatus);
  router.register('ocpp2.1', 'GetCertificateChainStatus', handleGetCertificateChainStatus);

  // Events and reports
  router.register('ocpp2.1', 'NotifyEvent', handleNotifyEvent);
  router.register('ocpp2.1', 'NotifyReport', handleNotifyReport);
  router.register('ocpp2.1', 'NotifyMonitoringReport', handleNotifyMonitoringReport);
  router.register('ocpp2.1', 'NotifyCustomerInformation', handleNotifyCustomerInformation);
  router.register('ocpp2.1', 'ReportChargingProfiles', handleReportChargingProfiles);

  // Charging management
  router.register('ocpp2.1', 'ClearedChargingLimit', handleClearedChargingLimit);
  router.register('ocpp2.1', 'NotifyChargingLimit', handleNotifyChargingLimit);
  router.register('ocpp2.1', 'NotifyEVChargingNeeds', handleNotifyEVChargingNeeds);
  router.register('ocpp2.1', 'NotifyEVChargingSchedule', handleNotifyEVChargingSchedule);
  router.register('ocpp2.1', 'NotifyPriorityCharging', handleNotifyPriorityCharging);
  router.register('ocpp2.1', 'PullDynamicScheduleUpdate', handlePullDynamicScheduleUpdate);

  // Reservations
  router.register('ocpp2.1', 'ReservationStatusUpdate', handleReservationStatusUpdate);

  // Display messages
  router.register('ocpp2.1', 'NotifyDisplayMessages', handleNotifyDisplayMessages);

  // Settlements and payments
  router.register('ocpp2.1', 'NotifySettlement', handleNotifySettlement);
  router.register('ocpp2.1', 'NotifyWebPaymentStarted', handleNotifyWebPaymentStarted);
  router.register('ocpp2.1', 'NotifyQRCodeScanned', handleNotifyQRCodeScanned);
  router.register('ocpp2.1', 'VatNumberValidation', handleVatNumberValidation);

  // Energy transfer
  router.register('ocpp2.1', 'NotifyAllowedEnergyTransfer', handleNotifyAllowedEnergyTransfer);
  router.register('ocpp2.1', 'BatterySwap', handleBatterySwap);

  // DER (Distributed Energy Resources)
  router.register('ocpp2.1', 'NotifyDERAlarm', handleNotifyDERAlarm);
  router.register('ocpp2.1', 'NotifyDERStartStop', handleNotifyDERStartStop);
  router.register('ocpp2.1', 'ReportDERControl', handleReportDERControl);

  // Periodic event streams
  router.register('ocpp2.1', 'NotifyPeriodicEventStream', handleNotifyPeriodicEventStream);
  router.register('ocpp2.1', 'OpenPeriodicEventStream', handleOpenPeriodicEventStream);
  router.register('ocpp2.1', 'ClosePeriodicEventStream', handleClosePeriodicEventStream);

  // Vendor extensions
  router.register('ocpp2.1', 'DataTransfer', handleDataTransfer);

  // ---- OCPP 1.6 handlers ----

  // Core lifecycle
  router.register('ocpp1.6', 'BootNotification', handleBootNotification16);
  router.register('ocpp1.6', 'Heartbeat', handleHeartbeat16);
  router.register('ocpp1.6', 'StatusNotification', handleStatusNotification16);

  // Authorization and transactions
  router.register('ocpp1.6', 'Authorize', handleAuthorize16);
  router.register('ocpp1.6', 'StartTransaction', handleStartTransaction16);
  router.register('ocpp1.6', 'StopTransaction', handleStopTransaction16);
  router.register('ocpp1.6', 'MeterValues', handleMeterValues16);

  // Firmware
  router.register('ocpp1.6', 'FirmwareStatusNotification', handleFirmwareStatus16);
  router.register('ocpp1.6', 'DiagnosticsStatusNotification', handleDiagnosticsStatus16);

  // Security extensions (OCPP 1.6 Security Whitepaper - reuse 2.1 handlers)
  router.register('ocpp1.6', 'SecurityEventNotification', handleSecurityEventNotification);
  router.register('ocpp1.6', 'SignCertificate', handleSignCertificate);
  router.register('ocpp1.6', 'LogStatusNotification', handleLogStatusNotification);
  router.register('ocpp1.6', 'SignedFirmwareStatusNotification', handleFirmwareStatusNotification);

  // Vendor extensions
  router.register('ocpp1.6', 'DataTransfer', handleDataTransfer16);
}
