// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

// Shared actor enum across every audit table. operator / driver / api_key /
// system / ocpp -- cron handlers and event projections write rows with
// actor='system' or actor='ocpp'.
export const auditActorEnum = pgEnum('audit_actor', [
  'operator',
  'driver',
  'api_key',
  'system',
  'ocpp',
]);

// ---------------------------------------------------------------------------
// Per-entity action enums + audit tables. Every table has the same shape:
// id, <entity>_id (nullable so audit row survives hard delete),
// <entity>_id_snapshot (text, preserves identity), action, actor + actor_*
// columns, before/after JSONB, notes, created_at. No FK to the source row.
// ---------------------------------------------------------------------------

export const siteAuditActionEnum = pgEnum('site_audit_action', [
  'created',
  'updated',
  'deleted',
  'payment_config_changed',
  'free_vend_toggled',
  'carbon_region_changed',
  'pricing_assignment_changed',
]);

export const siteAuditLog = pgTable(
  'site_audit_log',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id'),
    siteIdSnapshot: text('site_id_snapshot').notNull(),
    action: siteAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_site_audit_site_id').on(table.siteId),
    index('idx_site_audit_created_at').on(table.createdAt),
  ],
);

export const stationAuditActionEnum = pgEnum('station_audit_action', [
  'created',
  'updated',
  'deleted',
  'availability_changed',
  'onboarding_status_changed',
  'pricing_assignment_changed',
  'simulator_toggled',
  'command_dispatched',
  'certificate_installed',
  'configuration_pushed',
  'local_auth_pushed',
  'reset_triggered',
]);

export const stationAuditLog = pgTable(
  'station_audit_log',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id'),
    stationIdSnapshot: text('station_id_snapshot').notNull(),
    action: stationAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_station_audit_station_id').on(table.stationId),
    index('idx_station_audit_created_at').on(table.createdAt),
  ],
);

export const driverAuditActionEnum = pgEnum('driver_audit_action', [
  'created',
  'updated',
  'deleted',
  'activated',
  'deactivated',
  'password_reset',
  'email_verified',
  'fleet_assignment_changed',
  'pricing_assignment_changed',
]);

export const driverAuditLog = pgTable(
  'driver_audit_log',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id'),
    driverIdSnapshot: text('driver_id_snapshot').notNull(),
    action: driverAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_driver_audit_driver_id').on(table.driverId),
    index('idx_driver_audit_created_at').on(table.createdAt),
  ],
);

export const fleetAuditActionEnum = pgEnum('fleet_audit_action', [
  'created',
  'updated',
  'deleted',
  'member_added',
  'member_removed',
  'station_added',
  'station_removed',
  'pricing_assignment_changed',
]);

export const fleetAuditLog = pgTable(
  'fleet_audit_log',
  {
    id: serial('id').primaryKey(),
    fleetId: text('fleet_id'),
    fleetIdSnapshot: text('fleet_id_snapshot').notNull(),
    action: fleetAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fleet_audit_fleet_id').on(table.fleetId),
    index('idx_fleet_audit_created_at').on(table.createdAt),
  ],
);

export const userAuditActionEnum = pgEnum('user_audit_action', [
  'created',
  'updated',
  'deleted',
  'password_reset',
  'mfa_enabled',
  'mfa_disabled',
  'role_changed',
  'permissions_changed',
  'site_access_changed',
  'login_succeeded',
  'login_failed',
]);

export const userAuditLog = pgTable(
  'user_audit_log',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id'),
    userIdSnapshot: text('user_id_snapshot').notNull(),
    action: userAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_audit_user_id').on(table.userId),
    index('idx_user_audit_created_at').on(table.createdAt),
  ],
);

export const vehicleAuditActionEnum = pgEnum('vehicle_audit_action', [
  'created',
  'updated',
  'deleted',
]);

export const vehicleAuditLog = pgTable(
  'vehicle_audit_log',
  {
    id: serial('id').primaryKey(),
    vehicleId: text('vehicle_id'),
    vehicleIdSnapshot: text('vehicle_id_snapshot').notNull(),
    action: vehicleAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_vehicle_audit_vehicle_id').on(table.vehicleId),
    index('idx_vehicle_audit_created_at').on(table.createdAt),
  ],
);

export const supportCaseAuditActionEnum = pgEnum('support_case_audit_action', [
  'created',
  'updated',
  'deleted',
  'status_changed',
  'priority_changed',
  'category_changed',
  'assigned',
  'message_added',
  'attachment_added',
  'refund_issued',
  'sessions_linked',
  'sessions_unlinked',
]);

export const supportCaseAuditLog = pgTable(
  'support_case_audit_log',
  {
    id: serial('id').primaryKey(),
    supportCaseId: text('support_case_id'),
    supportCaseIdSnapshot: text('support_case_id_snapshot').notNull(),
    action: supportCaseAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_support_case_audit_case_id').on(table.supportCaseId),
    index('idx_support_case_audit_created_at').on(table.createdAt),
  ],
);

export const ocpiPartnerAuditActionEnum = pgEnum('ocpi_partner_audit_action', [
  'created',
  'updated',
  'deleted',
  'registered',
  'disconnected',
  'sync_triggered',
  'location_published_changed',
  'tariff_mapping_changed',
  'token_received',
]);

export const ocpiPartnerAuditLog = pgTable(
  'ocpi_partner_audit_log',
  {
    id: serial('id').primaryKey(),
    ocpiPartnerId: text('ocpi_partner_id'),
    ocpiPartnerIdSnapshot: text('ocpi_partner_id_snapshot').notNull(),
    action: ocpiPartnerAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_ocpi_partner_audit_partner_id').on(table.ocpiPartnerId),
    index('idx_ocpi_partner_audit_created_at').on(table.createdAt),
  ],
);

export const certificateAuditActionEnum = pgEnum('certificate_audit_action', [
  'csr_signed',
  'csr_rejected',
  'certificate_installed',
  'certificate_deleted',
  'ca_certificate_added',
  'ca_certificate_deleted',
  'root_certificates_refreshed',
  'pnc_settings_updated',
]);

export const certificateAuditLog = pgTable(
  'certificate_audit_log',
  {
    id: serial('id').primaryKey(),
    certificateId: text('certificate_id'),
    certificateIdSnapshot: text('certificate_id_snapshot').notNull(),
    action: certificateAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_certificate_audit_cert_id').on(table.certificateId),
    index('idx_certificate_audit_created_at').on(table.createdAt),
  ],
);

export const roleAuditActionEnum = pgEnum('role_audit_action', [
  'created',
  'updated',
  'deleted',
  'permissions_changed',
]);

export const roleAuditLog = pgTable(
  'role_audit_log',
  {
    id: serial('id').primaryKey(),
    roleId: text('role_id'),
    roleIdSnapshot: text('role_id_snapshot').notNull(),
    action: roleAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_role_audit_role_id').on(table.roleId),
    index('idx_role_audit_created_at').on(table.createdAt),
  ],
);

export const apiKeyAuditActionEnum = pgEnum('api_key_audit_action', [
  'created',
  'updated',
  'deleted',
  'revoked',
  'used',
]);

export const apiKeyAuditLog = pgTable(
  'api_key_audit_log',
  {
    id: serial('id').primaryKey(),
    apiKeyId: text('api_key_id'),
    apiKeyIdSnapshot: text('api_key_id_snapshot').notNull(),
    action: apiKeyAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_api_key_audit_key_id').on(table.apiKeyId),
    index('idx_api_key_audit_created_at').on(table.createdAt),
  ],
);

export const settingAuditActionEnum = pgEnum('setting_audit_action', ['updated']);

export const settingAuditLog = pgTable(
  'setting_audit_log',
  {
    id: serial('id').primaryKey(),
    settingKey: text('setting_key'),
    settingKeySnapshot: text('setting_key_snapshot').notNull(),
    action: settingAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_setting_audit_key').on(table.settingKey),
    index('idx_setting_audit_created_at').on(table.createdAt),
  ],
);

export const smartChargingTemplateAuditActionEnum = pgEnum('smart_charging_template_audit_action', [
  'created',
  'updated',
  'deleted',
  'pushed',
]);

export const smartChargingTemplateAuditLog = pgTable(
  'smart_charging_template_audit_log',
  {
    id: serial('id').primaryKey(),
    templateId: text('template_id'),
    templateIdSnapshot: text('template_id_snapshot').notNull(),
    action: smartChargingTemplateAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_smart_charging_template_audit_template_id').on(table.templateId),
    index('idx_smart_charging_template_audit_created_at').on(table.createdAt),
  ],
);

export const configTemplateAuditActionEnum = pgEnum('config_template_audit_action', [
  'created',
  'updated',
  'deleted',
  'pushed',
]);

export const configTemplateAuditLog = pgTable(
  'config_template_audit_log',
  {
    id: serial('id').primaryKey(),
    templateId: text('template_id'),
    templateIdSnapshot: text('template_id_snapshot').notNull(),
    action: configTemplateAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_config_template_audit_template_id').on(table.templateId),
    index('idx_config_template_audit_created_at').on(table.createdAt),
  ],
);

export const firmwareCampaignAuditActionEnum = pgEnum('firmware_campaign_audit_action', [
  'created',
  'updated',
  'deleted',
  'started',
  'paused',
  'resumed',
  'completed',
  'cancelled',
  'station_added',
  'station_removed',
]);

export const firmwareCampaignAuditLog = pgTable(
  'firmware_campaign_audit_log',
  {
    id: serial('id').primaryKey(),
    campaignId: text('campaign_id'),
    campaignIdSnapshot: text('campaign_id_snapshot').notNull(),
    action: firmwareCampaignAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_firmware_campaign_audit_campaign_id').on(table.campaignId),
    index('idx_firmware_campaign_audit_created_at').on(table.createdAt),
  ],
);

export const stationImageAuditActionEnum = pgEnum('station_image_audit_action', [
  'uploaded',
  'updated',
  'deleted',
  'set_main',
]);

export const stationImageAuditLog = pgTable(
  'station_image_audit_log',
  {
    id: serial('id').primaryKey(),
    stationImageId: text('station_image_id'),
    stationImageIdSnapshot: text('station_image_id_snapshot').notNull(),
    action: stationImageAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_station_image_audit_image_id').on(table.stationImageId),
    index('idx_station_image_audit_created_at').on(table.createdAt),
  ],
);

export const localAuthListAuditActionEnum = pgEnum('local_auth_list_audit_action', [
  'tokens_added',
  'tokens_removed',
  'pushed',
  'pulled',
]);

export const localAuthListAuditLog = pgTable(
  'local_auth_list_audit_log',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id'),
    stationIdSnapshot: text('station_id_snapshot').notNull(),
    action: localAuthListAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_local_auth_list_audit_station_id').on(table.stationId),
    index('idx_local_auth_list_audit_created_at').on(table.createdAt),
  ],
);

// Token audit. Migrated from the older token_audit_log via 0035.
export const tokenAuditActionEnum = pgEnum('token_audit_action', [
  'created',
  'updated',
  'activated',
  'deactivated',
  'revoked',
  'deleted',
  'imported',
]);

export const tokenAuditLog = pgTable(
  'token_audit_log',
  {
    id: serial('id').primaryKey(),
    tokenId: text('token_id'),
    tokenIdSnapshot: text('token_id_snapshot').notNull(),
    action: tokenAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_token_audit_token_id').on(table.tokenId),
    index('idx_token_audit_created_at').on(table.createdAt),
  ],
);

// Reservation audit. Migrated from the older reservation_audit_log via 0035.
export const reservationAuditActionEnum = pgEnum('reservation_audit_action', [
  'created',
  'updated',
  'cancelled',
  'expired',
  'used',
  'session_failed',
]);

export const reservationAuditLog = pgTable(
  'reservation_audit_log',
  {
    id: serial('id').primaryKey(),
    reservationId: text('reservation_id'),
    reservationIdSnapshot: text('reservation_id_snapshot').notNull(),
    action: reservationAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_reservation_audit_reservation_id').on(table.reservationId),
    index('idx_reservation_audit_created_at').on(table.createdAt),
  ],
);

// Pricing audit. Split from the older pricing_audit_log (which used an
// entity_type discriminator) into four per-entity tables via migration 0035.
export const pricingGroupAuditActionEnum = pgEnum('pricing_group_audit_action', [
  'created',
  'updated',
  'deleted',
]);
export const tariffAuditActionEnum = pgEnum('tariff_audit_action', [
  'created',
  'updated',
  'deleted',
]);
export const holidayAuditActionEnum = pgEnum('holiday_audit_action', [
  'created',
  'updated',
  'deleted',
]);
export const pricingAssignmentAuditActionEnum = pgEnum('pricing_assignment_audit_action', [
  'created',
  'updated',
  'deleted',
]);

export const pricingGroupAuditLog = pgTable(
  'pricing_group_audit_log',
  {
    id: serial('id').primaryKey(),
    pricingGroupId: text('pricing_group_id'),
    pricingGroupIdSnapshot: text('pricing_group_id_snapshot').notNull(),
    action: pricingGroupAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_group_audit_id').on(table.pricingGroupId),
    index('idx_pricing_group_audit_created_at').on(table.createdAt),
  ],
);

export const tariffAuditLog = pgTable(
  'tariff_audit_log',
  {
    id: serial('id').primaryKey(),
    tariffId: text('tariff_id'),
    tariffIdSnapshot: text('tariff_id_snapshot').notNull(),
    action: tariffAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_tariff_audit_id').on(table.tariffId),
    index('idx_tariff_audit_created_at').on(table.createdAt),
  ],
);

export const holidayAuditLog = pgTable(
  'holiday_audit_log',
  {
    id: serial('id').primaryKey(),
    holidayId: text('holiday_id'),
    holidayIdSnapshot: text('holiday_id_snapshot').notNull(),
    action: holidayAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_holiday_audit_id').on(table.holidayId),
    index('idx_holiday_audit_created_at').on(table.createdAt),
  ],
);

export const pricingAssignmentAuditLog = pgTable(
  'pricing_assignment_audit_log',
  {
    id: serial('id').primaryKey(),
    pricingAssignmentId: text('pricing_assignment_id'),
    pricingAssignmentIdSnapshot: text('pricing_assignment_id_snapshot').notNull(),
    action: pricingAssignmentAuditActionEnum('action').notNull(),
    actor: auditActorEnum('actor').notNull(),
    actorUserId: text('actor_user_id'),
    actorDriverId: text('actor_driver_id'),
    actorApiKeyId: text('actor_api_key_id'),
    actorLabel: varchar('actor_label', { length: 100 }),
    before: jsonb('before'),
    after: jsonb('after'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_pricing_assignment_audit_id').on(table.pricingAssignmentId),
    index('idx_pricing_assignment_audit_created_at').on(table.createdAt),
  ],
);

// Map of every audit table keyed by the entityType used in API filters.
// Used by the global GET /v1/audit endpoint (UNION over all tables) and by
// the worker retention prune job (DELETE FROM each).
export const AUDIT_TABLES = {
  site: siteAuditLog,
  station: stationAuditLog,
  driver: driverAuditLog,
  fleet: fleetAuditLog,
  user: userAuditLog,
  vehicle: vehicleAuditLog,
  support_case: supportCaseAuditLog,
  ocpi_partner: ocpiPartnerAuditLog,
  certificate: certificateAuditLog,
  role: roleAuditLog,
  api_key: apiKeyAuditLog,
  setting: settingAuditLog,
  smart_charging_template: smartChargingTemplateAuditLog,
  config_template: configTemplateAuditLog,
  firmware_campaign: firmwareCampaignAuditLog,
  station_image: stationImageAuditLog,
  local_auth_list: localAuthListAuditLog,
  token: tokenAuditLog,
  reservation: reservationAuditLog,
  pricing_group: pricingGroupAuditLog,
  tariff: tariffAuditLog,
  holiday: holidayAuditLog,
  pricing_assignment: pricingAssignmentAuditLog,
} as const;

export type AuditEntityType = keyof typeof AUDIT_TABLES;
