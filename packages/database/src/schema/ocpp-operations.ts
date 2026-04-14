// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  varchar,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { chargingStations } from './assets.js';
import { users } from './identity.js';

// --- Enums ---

export const chargingProfileSourceEnum = pgEnum('charging_profile_source', [
  'csms_set',
  'station_reported',
]);

export const firmwareUpdateStatusEnum = pgEnum('firmware_update_status', [
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'DownloadScheduled',
  'DownloadPaused',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
  'InstallRescheduled',
  'InstallVerificationFailed',
  'InvalidSignature',
  'SignatureVerified',
]);

export const logUploadStatusEnum = pgEnum('log_upload_status', [
  'BadMessage',
  'Idle',
  'NotSupportedOperation',
  'PermissionDenied',
  'Uploaded',
  'UploadFailure',
  'UploadFailed',
  'Uploading',
  'AcceptedCanceled',
]);

export const offlineCommandStatusEnum = pgEnum('offline_command_status', [
  'pending',
  'sent',
  'failed',
  'expired',
]);

// --- Tables ---

export const securityEvents = pgTable(
  'security_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 100 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull().default('info'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    techInfo: text('tech_info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_security_events_station_id').on(table.stationId),
    index('idx_security_events_type').on(table.type),
    index('idx_security_events_severity').on(table.severity),
    index('idx_security_events_timestamp').on(table.timestamp),
  ],
);

export const stationEvents = pgTable(
  'station_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    seqNo: integer('seq_no').notNull(),
    tbc: boolean('tbc').notNull().default(false),
    eventData: jsonb('event_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_station_events_station_id').on(table.stationId),
    index('idx_station_events_generated_at').on(table.generatedAt),
  ],
);

export const monitoringReports = pgTable(
  'monitoring_reports',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    requestId: integer('request_id').notNull(),
    seqNo: integer('seq_no').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    tbc: boolean('tbc').notNull().default(false),
    monitor: jsonb('monitor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_monitoring_reports_station_id').on(table.stationId),
    index('idx_monitoring_reports_request_id').on(table.requestId),
  ],
);

export const chargingProfiles = pgTable(
  'charging_profiles',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    source: chargingProfileSourceEnum('source').notNull(),
    evseId: integer('evse_id'),
    requestId: integer('request_id'),
    chargingLimitSource: varchar('charging_limit_source', { length: 50 }),
    tbc: boolean('tbc').notNull().default(false),
    profileData: jsonb('profile_data').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_charging_profiles_station_id').on(table.stationId),
    index('idx_charging_profiles_source').on(table.source),
    index('idx_charging_profiles_evse_id').on(table.evseId),
  ],
);

export const stationConfigurations = pgTable(
  'station_configurations',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    component: varchar('component', { length: 100 }).notNull(),
    instance: varchar('instance', { length: 50 }),
    evseId: integer('evse_id'),
    connectorId: integer('connector_id'),
    variable: varchar('variable', { length: 100 }).notNull(),
    variableInstance: varchar('variable_instance', { length: 50 }),
    value: text('value'),
    attributeType: varchar('attribute_type', { length: 20 }).notNull().default('Actual'),
    source: varchar('source', { length: 30 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_station_configurations_station_id').on(table.stationId),
    uniqueIndex('uq_station_configurations_composite').using(
      'btree',
      table.stationId,
      table.component,
      table.variable,
      sql`COALESCE(evse_id, -1)`,
      sql`COALESCE(connector_id, -1)`,
      table.attributeType,
    ),
  ],
);

export const firmwareUpdates = pgTable(
  'firmware_updates',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    requestId: integer('request_id'),
    firmwareUrl: text('firmware_url').notNull(),
    retrieveDateTime: timestamp('retrieve_date_time', { withTimezone: true }),
    status: firmwareUpdateStatusEnum('status'),
    statusInfo: jsonb('status_info'),
    campaignId: text('campaign_id'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull(),
    lastStatusAt: timestamp('last_status_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_firmware_updates_station_id').on(table.stationId),
    index('idx_firmware_updates_request_id').on(table.requestId),
    index('idx_firmware_updates_status').on(table.status),
  ],
);

export const customerInformationReports = pgTable(
  'customer_information_reports',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    requestId: integer('request_id').notNull(),
    seqNo: integer('seq_no').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    tbc: boolean('tbc').notNull().default(false),
    data: text('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_customer_info_reports_station_id').on(table.stationId),
    index('idx_customer_info_reports_request_id').on(table.requestId),
  ],
);

export const logUploads = pgTable(
  'log_uploads',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    requestId: integer('request_id'),
    logType: varchar('log_type', { length: 50 }),
    remoteLocation: text('remote_location'),
    status: logUploadStatusEnum('status'),
    statusInfo: jsonb('status_info'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }),
    lastStatusAt: timestamp('last_status_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_log_uploads_station_id').on(table.stationId),
    index('idx_log_uploads_request_id').on(table.requestId),
  ],
);

// --- EV Charging Needs ---

export const evChargingNeeds = pgTable(
  'ev_charging_needs',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    chargingNeeds: jsonb('charging_needs').notNull(),
    departureTime: timestamp('departure_time', { withTimezone: true }),
    requestedEnergyTransfer: varchar('requested_energy_transfer', { length: 50 }),
    controlMode: varchar('control_mode', { length: 50 }),
    maxScheduleTuples: integer('max_schedule_tuples'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ev_charging_needs_station_id').on(table.stationId),
    uniqueIndex('uq_ev_charging_needs_station_evse').on(table.stationId, table.evseId),
  ],
);

export const evChargingSchedules = pgTable(
  'ev_charging_schedules',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id').notNull(),
    timeBase: timestamp('time_base', { withTimezone: true }),
    chargingSchedule: jsonb('charging_schedule').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_ev_charging_schedules_station_id').on(table.stationId)],
);

// --- Variable Monitoring Rules ---

export const variableMonitorStatusEnum = pgEnum('variable_monitor_status', [
  'pending',
  'active',
  'cleared',
  'error',
]);

export const variableMonitoringRules = pgTable(
  'variable_monitoring_rules',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    monitoringId: integer('monitoring_id'),
    component: varchar('component', { length: 100 }).notNull(),
    variable: varchar('variable', { length: 100 }).notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    value: numeric('value').notNull(),
    severity: integer('severity').notNull().default(0),
    status: variableMonitorStatusEnum('status').notNull().default('pending'),
    errorInfo: text('error_info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_variable_monitoring_rules_station_id').on(table.stationId),
    index('idx_variable_monitoring_rules_status').on(table.status),
  ],
);

// --- Offline Command Queue ---

export const offlineCommandQueue = pgTable(
  'offline_command_queue',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id').notNull(),
    commandId: varchar('command_id', { length: 36 }).notNull().unique(),
    action: varchar('action', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    version: varchar('version', { length: 20 }),
    status: offlineCommandStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_offline_cmd_queue_station_id').on(table.stationId),
    index('idx_offline_cmd_queue_status').on(table.status),
    index('idx_offline_cmd_queue_expires_at').on(table.expiresAt),
  ],
);

// -- OCPP 2.1 stub persistence tables --

export const batterySwapEvents = pgTable(
  'battery_swap_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 50 }).notNull(),
    transactionId: text('transaction_id'),
    idToken: jsonb('id_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_battery_swap_events_station').on(table.stationId)],
);

export const periodicEventStreams = pgTable(
  'periodic_event_streams',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    streamId: integer('stream_id').notNull(),
    data: jsonb('data').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_periodic_event_streams_station').on(table.stationId)],
);

export const qrScanEvents = pgTable(
  'qr_scan_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id'),
    timeout: integer('timeout'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_qr_scan_events_station').on(table.stationId)],
);

// -- OCPP 2.1 additional stub persistence tables --

export const vatNumberValidations = pgTable(
  'vat_number_validations',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    vatNumber: text('vat_number'),
    evseId: integer('evse_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_vat_number_validations_station').on(table.stationId)],
);

export const webPaymentEvents = pgTable(
  'web_payment_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    evseId: integer('evse_id'),
    timeout: integer('timeout'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_web_payment_events_station').on(table.stationId)],
);

export const allowedEnergyTransferEvents = pgTable(
  'allowed_energy_transfer_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id'),
    allowedEnergyTransfer: jsonb('allowed_energy_transfer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_allowed_energy_transfer_events_station').on(table.stationId)],
);

export const derAlarmEvents = pgTable(
  'der_alarm_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    controlType: text('control_type'),
    timestamp: timestamp('timestamp', { withTimezone: true }),
    gridEventFault: jsonb('grid_event_fault'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_der_alarm_events_station').on(table.stationId)],
);

export const derStartStopEvents = pgTable(
  'der_start_stop_events',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    controlType: text('control_type'),
    started: boolean('started'),
    timestamp: timestamp('timestamp', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_der_start_stop_events_station').on(table.stationId)],
);

export const derControlReports = pgTable(
  'der_control_reports',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    requestId: integer('request_id'),
    seqNo: integer('seq_no'),
    tbc: boolean('tbc').notNull().default(false),
    derControl: jsonb('der_control'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_der_control_reports_station').on(table.stationId)],
);

// -- NotifyEvent Alerting --

export const eventAlertRules = pgTable(
  'event_alert_rules',
  {
    id: serial('id').primaryKey(),
    component: varchar('component', { length: 100 }).notNull(),
    variable: varchar('variable', { length: 100 }).notNull(),
    minSeverity: integer('min_severity').notNull().default(0),
    isEnabled: boolean('is_enabled').notNull().default(true),
    notifyChannel: varchar('notify_channel', { length: 50 }).notNull().default('email'),
    notifyRecipient: varchar('notify_recipient', { length: 500 }).notNull().default('$admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_event_alert_rules_component_variable').on(table.component, table.variable),
  ],
);

export const eventAlerts = pgTable(
  'event_alerts',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    stationEventId: integer('station_event_id').references(() => stationEvents.id, {
      onDelete: 'set null',
    }),
    ruleId: integer('rule_id').references(() => eventAlertRules.id, { onDelete: 'set null' }),
    component: varchar('component', { length: 100 }),
    variable: varchar('variable', { length: 100 }),
    severity: integer('severity'),
    trigger: varchar('trigger', { length: 50 }),
    actualValue: text('actual_value'),
    techInfo: text('tech_info'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: text('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_event_alerts_station').on(table.stationId),
    index('idx_event_alerts_severity').on(table.severity),
    index('idx_event_alerts_acknowledged').on(table.acknowledgedAt),
  ],
);
