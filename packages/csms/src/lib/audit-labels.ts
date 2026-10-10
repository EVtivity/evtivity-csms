// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';

// Every audited entity type: the keys of AUDIT_TABLES in
// packages/database/src/schema/audit.ts. Labels: audit.entities.<type>.
export const AUDIT_ENTITY_TYPES = [
  'site',
  'station',
  'driver',
  'fleet',
  'user',
  'vehicle',
  'support_case',
  'ocpi_partner',
  'certificate',
  'role',
  'api_key',
  'setting',
  'smart_charging_template',
  'config_template',
  'firmware_campaign',
  'station_image',
  'local_auth_list',
  'token',
  'reservation',
  'pricing_group',
  'tariff',
  'holiday',
  'pricing_assignment',
  'maintenance_event',
  'session',
  'invoice',
  'ai_conversation',
] as const;

export const AUDIT_ACTORS = ['operator', 'driver', 'api_key', 'system', 'ocpp'] as const;

// Union of every value of the per-entity *_audit_action enums in
// packages/database/src/schema/audit.ts, sorted. Labels: audit.actions.<action>.
// audit-labels.test.ts fails when an enum value is missing here or has no en label.
export const AUDIT_ACTIONS = [
  'action_confirmed',
  'action_rejected',
  'activated',
  'assigned',
  'attachment_added',
  'availability_changed',
  'billing_updated',
  'ca_certificate_added',
  'ca_certificate_deleted',
  'cancelled',
  'carbon_region_changed',
  'category_changed',
  'certificate_deleted',
  'certificate_installed',
  'command_dispatched',
  'completed',
  'configuration_pushed',
  'created',
  'csr_rejected',
  'csr_signed',
  'deactivated',
  'deleted',
  'disconnected',
  'email_verified',
  'ended',
  'expired',
  'fleet_assignment_changed',
  'free_vend_toggled',
  'imported',
  'invoice_credited',
  'invoice_generated',
  'invoice_sent',
  'local_auth_pushed',
  'location_published_changed',
  'login_failed',
  'login_succeeded',
  'manual_billing',
  'marked_paid',
  'member_added',
  'member_billing_opt_out_changed',
  'member_removed',
  'message_added',
  'mfa_disabled',
  'mfa_enabled',
  'onboarding_status_changed',
  'password_reset',
  'paused',
  'payment_config_changed',
  'permissions_changed',
  'pnc_settings_updated',
  'portal_activated',
  'portal_invited',
  'pricing_assignment_changed',
  'priority_changed',
  'pulled',
  'pushed',
  'rebilled',
  'refund_issued',
  'registered',
  'renamed',
  'reordered',
  'reservations_cancelled',
  'reset_triggered',
  'resumed',
  'revoked',
  'role_changed',
  'root_certificates_refreshed',
  'session_failed',
  'sessions_linked',
  'sessions_stopped',
  'sessions_unlinked',
  'set_main',
  'simulator_toggled',
  'site_access_changed',
  'started',
  'station_added',
  'station_removed',
  'status_changed',
  'sync_triggered',
  'tariff_mapping_changed',
  'token_received',
  'tokens_added',
  'tokens_removed',
  'tool_called',
  'updated',
  'uploaded',
  'used',
  'voided',
] as const;

/** A code the locale files do not know, made readable: `invoice_sent` -> `Invoice sent`. */
export function humanizeAuditCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  if (words === '') return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditActionLabel(t: TFunction, action: string): string {
  return t(`audit.actions.${action}`, {
    defaultValue: humanizeAuditCode(action),
  });
}

export function auditEntityLabel(t: TFunction, entityType: string): string {
  return t(`audit.entities.${entityType}`, {
    defaultValue: humanizeAuditCode(entityType),
  });
}

export function auditActorLabel(t: TFunction, actor: string): string {
  return t(`audit.actors.${actor}`, {
    defaultValue: humanizeAuditCode(actor),
  });
}
