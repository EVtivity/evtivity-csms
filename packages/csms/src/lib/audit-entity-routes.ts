// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Permission } from '@evtivity/lib/permissions';
import type { AUDIT_ENTITY_TYPES } from '@/lib/audit-labels';

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditEntityRoute {
  /** The CSMS page of the entity with this id (the audit row's `entityId`). */
  path: (id: string) => string;
  /** The permission the page needs; Go to Entity shows only with it. */
  permission: Permission;
}

const byId =
  (prefix: string) =>
  (id: string): string =>
    `${prefix}/${encodeURIComponent(id)}`;

/**
 * Where the audit entry dialog's Go to Entity button leads, per entity type.
 * `null`: the entity has no page of its own reachable from its id alone (a
 * vehicle or a tariff page also needs its driver or pricing group, a
 * maintenance event its site) or no detail page at all.
 */
export const AUDIT_ENTITY_ROUTES: Record<AuditEntityType, AuditEntityRoute | null> = {
  site: { path: byId('/sites'), permission: 'sites:read' },
  station: { path: byId('/stations'), permission: 'stations:read' },
  driver: { path: byId('/drivers'), permission: 'drivers:read' },
  fleet: { path: byId('/fleets'), permission: 'fleets:read' },
  user: { path: byId('/users'), permission: 'users:read' },
  vehicle: null,
  support_case: { path: byId('/support-cases'), permission: 'support:read' },
  ocpi_partner: { path: byId('/roaming/partners'), permission: 'roaming:read' },
  certificate: null,
  role: null,
  api_key: null,
  setting: { path: () => '/settings?tab=history', permission: 'audit:read' },
  smart_charging_template: {
    path: byId('/smart-charging'),
    permission: 'settings.smartCharging:read',
  },
  config_template: {
    path: byId('/station-configurations'),
    permission: 'settings.stationConfig:read',
  },
  firmware_campaign: { path: byId('/firmware-campaigns'), permission: 'settings.firmware:read' },
  station_image: null,
  local_auth_list: null,
  token: { path: byId('/tokens'), permission: 'drivers:read' },
  reservation: { path: byId('/reservations'), permission: 'reservations:read' },
  pricing_group: { path: byId('/pricing'), permission: 'pricing:read' },
  tariff: null,
  holiday: { path: () => '/pricing/holidays', permission: 'pricing:read' },
  pricing_assignment: null,
  maintenance_event: null,
  session: { path: byId('/sessions'), permission: 'sessions:read' },
  invoice: { path: byId('/invoices'), permission: 'payments:read' },
  ai_conversation: null,
  ai_proposal: null,
  ai_insight: { path: byId('/ai/insights'), permission: 'aiInsights:read' },
  payment: null,
  notification_template: null,
  station_message_template: null,
  event_alert_rule: null,
  report_schedule: null,
  sim: { path: byId('/sims'), permission: 'sims:read' },
};

export function auditEntityRoute(entityType: string): AuditEntityRoute | null {
  return (AUDIT_ENTITY_ROUTES as Record<string, AuditEntityRoute | null>)[entityType] ?? null;
}
