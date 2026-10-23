// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { db, getSimByIccid } from '@evtivity/database';
import { buildCsv, isValidIccid, normalizeIccid } from '@evtivity/lib';
import {
  pushStationDataPlanChanges,
  snapshotStationDataPlans,
  type StationDataPlanSnapshot,
} from '@evtivity/services/station-data-plan.service';
import {
  attachSim,
  ensureSim,
  updateSim,
  type SimActor,
} from '@evtivity/services/sim-inventory.service';
import { exportSimViews, stationByOcppId, type SimListFilters } from '../lib/sim-views.js';

// The SIM CSV import, export and template. The import reads the
// first five columns; the others are written by the export only and ignored by
// the import. Every write goes through the SIM inventory service, which writes
// the SIM and station audit rows. No provider is called.

export const SIM_CSV_HEADER = [
  'iccid',
  'imsi',
  'label',
  'notes',
  'stationId',
  'status',
  'provider',
  'providerState',
  'attachedStationId',
  'attachmentConfirmed',
] as const;

/** Rows one import takes (the route schema refuses more with 400). */
export const SIM_IMPORT_MAX_ROWS = 10_000;
export const SIM_LABEL_MAX = 100;
export const SIM_NOTES_MAX = 2000;
const IMSI = /^\d{1,15}$/;
const IMPORT_NOTE = 'CSV import';

const TEMPLATE_ROWS: string[][] = [
  ['8901260000000000018', '310260000000001', 'Depot router', 'Cabinet 1', 'CS-001'],
  ['8901260000000000026', '', 'Spare SIM', '', ''],
];

export interface SimImportRow {
  iccid: string;
  imsi?: string | undefined;
  label?: string | undefined;
  notes?: string | undefined;
  /** The OCPP identity of the station to attach the SIM to. */
  stationId?: string | undefined;
}

export interface SimImportResult {
  created: number;
  updated: number;
  attached: number;
  /** One `Row N: <reason>` per refused or skipped row. */
  errors: string[];
}

/** The template: the header and example rows; the export-only columns stay empty. */
export function exportSimTemplateCsv(): string {
  const exportOnly = SIM_CSV_HEADER.length - 5;
  return buildCsv(
    [...SIM_CSV_HEADER],
    TEMPLATE_ROWS.map((row) => [...row, ...Array<string>(exportOnly).fill('')]),
  );
}

/**
 * Every SIM the user sees with the list filters, newest
 * first. `status` is the CSMS status (Deactivate, Reactivate), apart from the
 * provider state of the last Refresh.
 */
export async function exportSimsCsv(
  filters: SimListFilters,
  siteIds: string[] | null,
): Promise<string> {
  const views = await exportSimViews(filters, siteIds);
  return buildCsv(
    [...SIM_CSV_HEADER],
    views.map((view) => {
      const state = (view.lastStatus as { state?: unknown } | null)?.state;
      return [
        view.iccid,
        view.imsi ?? '',
        view.label ?? '',
        view.notes ?? '',
        view.attachment?.stationOcppId ?? '',
        view.status,
        view.provider ?? '',
        typeof state === 'string' ? state : '',
        view.attachment?.stationId ?? '',
        view.attachment == null ? '' : String(view.attachment.confirmed),
      ];
    }),
  );
}

/** A refused row: its savepoint rolls back, so the row leaves nothing behind. */
class RowRefused extends Error {}

function cell(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text == null || text === '' ? undefined : text;
}

/** The row's problem, else null. */
function rowProblem(row: SimImportRow): string | null {
  if (!isValidIccid(row.iccid)) return 'invalid ICCID';
  const imsi = cell(row.imsi);
  if (imsi != null && !IMSI.test(imsi)) return 'invalid IMSI (up to 15 digits)';
  if ((cell(row.label)?.length ?? 0) > SIM_LABEL_MAX) {
    return `label longer than ${String(SIM_LABEL_MAX)} characters`;
  }
  if ((cell(row.notes)?.length ?? 0) > SIM_NOTES_MAX) {
    return `notes longer than ${String(SIM_NOTES_MAX)} characters`;
  }
  return null;
}

function attachRefusal(kind: string, stationOcppId: string): string {
  switch (kind) {
    case 'station_has_sim':
      return `station "${stationOcppId}" already has another SIM`;
    case 'sim_attached_elsewhere':
      return 'SIM is attached to another station';
    case 'sim_inactive':
      return 'SIM is inactive, not attached';
    default:
      return 'SIM not found';
  }
}

/**
 * Imports SIM rows in one transaction, each row in its own savepoint. A new
 * ICCID creates the SIM; an existing one is updated (IMSI, label, notes) only
 * with `updateExisting`, else skipped. An empty cell keeps the field. A row
 * naming a station attaches the SIM there (`imported`, confirmed: the caller
 * checked access to every site). A row refused at the attach (a station with
 * another SIM, a SIM attached elsewhere, an inactive SIM) rolls back, so it
 * creates and changes nothing. Nothing is ever detached or displaced.
 */
export async function importSimsCsv(
  rows: SimImportRow[],
  updateExisting: boolean,
  actor: SimActor,
  log?: FastifyBaseLogger,
): Promise<SimImportResult> {
  const result: SimImportResult = { created: 0, updated: 0, attached: 0, errors: [] };
  const input = { actor, notes: IMPORT_NOTE, ...(log != null ? { log } : {}) };
  const seen = new Set<string>();
  // A confirmed SIM moves its station to the Cellular data plan: the plans
  // read before the import (committed state) are compared after the commit.
  const planBefore: StationDataPlanSnapshot = new Map();

  await db.transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      const fail = (reason: string): void => {
        result.errors.push(`Row ${String(index + 1)}: ${reason}`);
      };
      const problem = rowProblem(row);
      if (problem != null) {
        fail(problem);
        continue;
      }
      const iccid = normalizeIccid(row.iccid) ?? row.iccid;
      // A second row for a SIM an earlier row already wrote; an ICCID whose
      // earlier row was refused may come again.
      if (seen.has(iccid)) {
        fail('duplicate ICCID in the file');
        continue;
      }

      const existing = await getSimByIccid(iccid, tx);
      if (existing != null && !updateExisting) {
        fail('SIM already exists, skipped');
        continue;
      }
      const stationOcppId = cell(row.stationId);
      let stationId: string | null = null;
      if (stationOcppId != null) {
        const station = await stationByOcppId(stationOcppId, tx);
        if (station == null) {
          fail(`station "${stationOcppId}" not found`);
          continue;
        }
        stationId = station.id;
        if (!planBefore.has(stationId)) {
          const before = await snapshotStationDataPlans([stationId], log != null ? { log } : {});
          for (const [id, state] of before) planBefore.set(id, state);
        }
      }
      const imsi = cell(row.imsi);
      const label = cell(row.label);
      const notes = cell(row.notes);
      const fields = {
        ...(imsi != null ? { imsi } : {}),
        ...(label != null ? { label } : {}),
        ...(notes != null ? { notes } : {}),
      };

      try {
        const outcome = await tx.transaction(async (sp) => {
          // A new SIM gets its fields in its insert (one `created` audit row). A
          // SIM another writer created meanwhile counts as an existing one.
          const record =
            existing != null
              ? { sim: existing, created: false }
              : await ensureSim(iccid, { ...input, fields }, sp);
          if (!record.created && !updateExisting) {
            throw new RowRefused('SIM already exists, skipped');
          }
          const { sim } = record;
          let updated = false;
          if (!record.created && Object.keys(fields).length > 0) {
            const change = await updateSim(sim.id, fields, input, sp);
            updated = change != null && change.before !== change.after;
          }
          let attached = false;
          if (stationId != null && stationOcppId != null) {
            const attach = await attachSim(sim.id, stationId, { ...input, source: 'imported' }, sp);
            if (attach.kind !== 'attached' && attach.kind !== 'unchanged') {
              throw new RowRefused(attachRefusal(attach.kind, stationOcppId));
            }
            attached = attach.kind === 'attached';
          }
          return { created: record.created, updated, attached };
        });
        seen.add(iccid);
        if (outcome.created) result.created += 1;
        else if (outcome.updated) result.updated += 1;
        if (outcome.attached) result.attached += 1;
      } catch (err: unknown) {
        if (!(err instanceof RowRefused)) throw err;
        fail(err.message);
      }
    }
  });
  await pushStationDataPlanChanges(planBefore, log != null ? { log } : {});
  return result;
}
