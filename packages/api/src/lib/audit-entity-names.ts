// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '@evtivity/database';
import type { AuditEntityType } from '@evtivity/database';
import { simVisibleSql } from './sim-site-scope.js';
import { supportCaseSiteCondition } from './support-case-scope.js';

/**
 * The readable name of each audited entity type: one query per type present in
 * a page of audit rows, never one per row. Each query selects `id` (text) and
 * `name` (text, null when the entity has no readable name). Types missing here
 * have no readable name, and the audit list shows a dash for them (the entry
 * dialog keeps the copyable id).
 */
const NAME_QUERIES: Partial<Record<AuditEntityType, (ids: SQL) => SQL>> = {
  site: (ids) => sql`SELECT id::text AS id, name FROM sites WHERE id::text IN (${ids})`,
  station: (ids) =>
    sql`SELECT id::text AS id, station_id AS name FROM charging_stations WHERE id::text IN (${ids})`,
  local_auth_list: (ids) =>
    sql`SELECT id::text AS id, station_id AS name FROM charging_stations WHERE id::text IN (${ids})`,
  driver: (ids) => sql`
    SELECT id::text AS id, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS name
    FROM drivers WHERE id::text IN (${ids})`,
  user: (ids) => sql`
    SELECT id::text AS id, COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS name
    FROM users WHERE id::text IN (${ids})`,
  fleet: (ids) => sql`SELECT id::text AS id, name FROM fleets WHERE id::text IN (${ids})`,
  vehicle: (ids) => sql`
    SELECT id::text AS id, COALESCE(NULLIF(TRIM(COALESCE(make, '') || ' ' || COALESCE(model, '')), ''), license_plate) AS name
    FROM vehicles WHERE id::text IN (${ids})`,
  support_case: (ids) =>
    sql`SELECT id::text AS id, case_number AS name FROM support_cases WHERE id::text IN (${ids})`,
  ocpi_partner: (ids) =>
    sql`SELECT id::text AS id, name FROM ocpi_partners WHERE id::text IN (${ids})`,
  role: (ids) => sql`SELECT id::text AS id, name FROM roles WHERE id::text IN (${ids})`,
  api_key: (ids) => sql`SELECT id::text AS id, name FROM refresh_tokens WHERE id::text IN (${ids})`,
  config_template: (ids) =>
    sql`SELECT id::text AS id, name FROM config_templates WHERE id::text IN (${ids})`,
  firmware_campaign: (ids) =>
    sql`SELECT id::text AS id, name FROM firmware_campaigns WHERE id::text IN (${ids})`,
  pricing_group: (ids) =>
    sql`SELECT id::text AS id, name FROM pricing_groups WHERE id::text IN (${ids})`,
  tariff: (ids) => sql`SELECT id::text AS id, name FROM tariffs WHERE id::text IN (${ids})`,
  holiday: (ids) =>
    sql`SELECT id::text AS id, name FROM pricing_holidays WHERE id::text IN (${ids})`,
  invoice: (ids) =>
    sql`SELECT id::text AS id, invoice_number AS name FROM invoices WHERE id::text IN (${ids})`,
  ai_conversation: (ids) =>
    sql`SELECT id::text AS id, NULLIF(title, '') AS name FROM ai_conversations WHERE id::text IN (${ids})`,
  report_schedule: (ids) =>
    sql`SELECT id::text AS id, name FROM report_schedules WHERE id::text IN (${ids})`,
  sim: (ids) =>
    sql`SELECT id::text AS id, COALESCE(label, iccid) AS name FROM sims WHERE id::text IN (${ids})`,
  payment_terminal: (ids) => sql`
    SELECT id::text AS id, COALESCE(label, serial_number, provider_device_id) AS name
    FROM payment_terminals WHERE id::text IN (${ids})`,
  depot_system: (ids) =>
    sql`SELECT id::text AS id, name FROM depot_systems WHERE id::text IN (${ids})`,
  token: (ids) =>
    sql`SELECT id::text AS id, id_token AS name FROM driver_tokens WHERE id::text IN (${ids})`,
  reservation: (ids) =>
    sql`SELECT id::text AS id, '#' || reservation_id::text AS name FROM reservations WHERE id::text IN (${ids})`,
  session: (ids) => sql`
    SELECT s.id::text AS id, cs.station_id || ' #' || s.transaction_id AS name
    FROM charging_sessions s JOIN charging_stations cs ON cs.id = s.station_id
    WHERE s.id::text IN (${ids})`,
  event_alert_rule: (ids) => sql`
    SELECT id::text AS id, component || '.' || variable AS name
    FROM event_alert_rules WHERE id::text IN (${ids})`,
};

/**
 * The current-scope condition of each type, for a site-restricted viewer: a
 * current name is read only while the entity is inside the viewer's sites now.
 * Audit rows of several types show by the site at write time (a session by its
 * own site, a payment terminal and a departure by `auditSiteId`, a SIM by its
 * attachment windows), so after a move the entity's current name (terminal
 * label, station OCPP id, SIM label) could belong to another site (security
 * case 390). Each condition refers to the table of its query in
 * NAME_QUERIES. A type without one gets no current name for a site-restricted
 * viewer, only the row's own snapshot name.
 */
const SCOPE_CONDITIONS: Partial<
  Record<AuditEntityType, (siteList: SQL, siteIds: string[]) => SQL>
> = {
  site: (siteList) => sql`sites.id::text IN (${siteList})`,
  station: (siteList) => sql`charging_stations.site_id IN (${siteList})`,
  local_auth_list: (siteList) => sql`charging_stations.site_id IN (${siteList})`,
  session: (siteList) => sql`s.site_id IN (${siteList}) AND cs.site_id IN (${siteList})`,
  reservation: (siteList) =>
    sql`EXISTS (SELECT 1 FROM charging_stations rcs WHERE rcs.id = reservations.station_id AND rcs.site_id IN (${siteList}))`,
  payment_terminal: (siteList) => sql`payment_terminals.site_id IN (${siteList})`,
  sim: (_siteList, siteIds) => simVisibleSql(sql`sims.id`, siteIds),
  support_case: (_siteList, siteIds) => supportCaseSiteCondition(siteIds),
};

/** A name the row's own snapshot holds, for an entity that no longer exists. */
function snapshotName(row: { before: unknown; after: unknown }): string | null {
  for (const snap of [row.after, row.before]) {
    if (snap == null || typeof snap !== 'object') continue;
    for (const key of ['name', 'label']) {
      const value = (snap as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return null;
}

interface NamedAuditRow {
  entityType: string;
  entityId: string | null;
  entityIdSnapshot: string;
  before: unknown;
  after: unknown;
  entityName?: string | null;
}

/**
 * Sets `entityName` on each audit row: the entity's readable name (station OCPP
 * id, site name, driver name, and so on), else a name its snapshot holds, else
 * null. A setting is named by its key. `siteIds` is the viewer's site scope
 * (`getUserSiteIds`, null for an all-site viewer): a site-restricted viewer
 * gets a current name only while the entity is inside its sites now
 * (SCOPE_CONDITIONS), else the row's snapshot name. Fail-open: a failed lookup leaves the
 * name null and the list still answers.
 */
export async function resolveAuditEntityNames(
  rows: NamedAuditRow[],
  siteIds: string[] | null,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  const siteList =
    siteIds != null && siteIds.length > 0
      ? sql.join(
          siteIds.map((siteId) => sql`${siteId}`),
          sql`, `,
        )
      : null;
  const idsByType = new Map<AuditEntityType, Set<string>>();
  for (const row of rows) {
    const type = row.entityType as AuditEntityType;
    if (NAME_QUERIES[type] == null) continue;
    // A site-restricted viewer gets a current name only for a type whose
    // current site can be checked, and only with sites of its own.
    if (siteIds != null && (siteList == null || SCOPE_CONDITIONS[type] == null)) continue;
    const id = row.entityId ?? row.entityIdSnapshot;
    if (id === '') continue;
    let set = idsByType.get(type);
    if (set == null) {
      set = new Set();
      idsByType.set(type, set);
    }
    set.add(id);
  }
  const names = new Map<string, string | null>();
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      const query = NAME_QUERIES[type];
      if (query == null) return;
      const scope = siteList != null && siteIds != null ? SCOPE_CONDITIONS[type] : undefined;
      if (siteIds != null && scope == null) return;
      const idList = sql.join(
        [...ids].map((id) => sql`${id}`),
        sql`, `,
      );
      const base = query(idList);
      const statement =
        scope != null && siteList != null && siteIds != null
          ? sql`${base} AND ${scope(siteList, siteIds)}`
          : base;
      try {
        const res = await db.execute(statement);
        for (const r of res as unknown as Array<{ id: string; name: string | null }>) {
          names.set(`${type}:${r.id}`, r.name);
        }
      } catch (err) {
        log?.warn({ err, entityType: type }, 'Audit entity name lookup failed, showing no name');
      }
    }),
  );
  for (const row of rows) {
    if (row.entityType === 'setting') {
      row.entityName = row.entityId ?? row.entityIdSnapshot;
      continue;
    }
    const id = row.entityId ?? row.entityIdSnapshot;
    const name = names.get(`${row.entityType}:${id}`) ?? null;
    row.entityName = name != null && name.trim() !== '' ? name : snapshotName(row);
  }
}
