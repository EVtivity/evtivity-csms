// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/audit` (`api/routes.md`, "List sorting"). The list is a
 * UNION ALL of the audit tables, whose ORDER BY may name only output columns, so every key
 * is an output column of the union. Audit row ids are serials per table, so the
 * tie-breaker is the entity type and the id together.
 */
export const auditListSort = defineListSort(
  {
    createdAt: sql.raw('created_at'),
    entityType: sql.raw('entity_type'),
    action: sql.raw('action'),
    actorType: sql.raw('actor'),
  },
  {
    tieBreaker: sql.raw('entity_type, id'),
    defaultOrder: [sql.raw('created_at DESC'), sql.raw('entity_type ASC'), sql.raw('id DESC')],
  },
);

/** The sort keys of `GET /v1/audit/:entityType/:entityId`. */
export const ENTITY_AUDIT_SORT_KEYS = ['createdAt', 'action', 'actorType'] as const;
export type EntityAuditSortKey = (typeof ENTITY_AUDIT_SORT_KEYS)[number];

/**
 * The sortable columns of `GET /v1/audit/:entityType/:entityId`, ordered in each audit
 * table it reads. The route merges those tables in TypeScript with the same order
 * (`compareEntityAuditRows`), so text is compared byte-wise (`COLLATE "C"`), as JavaScript
 * compares strings.
 */
export const entityAuditListSort = defineListSort(
  {
    createdAt: sql.raw('created_at'),
    action: sql.raw('action::text COLLATE "C"'),
    actorType: sql.raw('actor::text COLLATE "C"'),
  },
  {
    tieBreaker: sql.raw('id'),
    defaultOrder: [sql.raw('created_at DESC'), sql.raw('id DESC')],
  },
);

interface EntityAuditSortRow {
  id: number;
  entityType: string;
  action: string;
  actor: string;
  createdAt: string;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The order of the merged per-entity history, the same as each table's ORDER BY: the
 * sorted column, then the id in the same direction, then the entity type, so the order is
 * stable across pages. Without a sort key, newest first.
 */
export function compareEntityAuditRows(
  a: EntityAuditSortRow,
  b: EntityAuditSortRow,
  params: { sort?: EntityAuditSortKey | undefined; order?: 'asc' | 'desc' | undefined },
): number {
  if (params.sort == null) {
    return (
      compareText(b.createdAt, a.createdAt) ||
      b.id - a.id ||
      compareText(a.entityType, b.entityType)
    );
  }
  const sign = params.order === 'desc' ? -1 : 1;
  let primary: number;
  if (params.sort === 'action') primary = compareText(a.action, b.action);
  else if (params.sort === 'actorType') primary = compareText(a.actor, b.actor);
  else primary = compareText(a.createdAt, b.createdAt);
  return sign * primary || sign * (a.id - b.id) || compareText(a.entityType, b.entityType);
}
