// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportSiteScope } from './report-scope.js';

/** File formats a report can be written in. */
export const REPORT_FORMATS = ['csv', 'pdf', 'xlsx'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportGeneratorResult {
  data: Buffer;
  fileName: string;
}

/**
 * Builds a report file. `language` sets its labels and PDF formatting
 * (report-generators/report-locale.ts). NEVI ignores it: the EV-ChART template
 * has fixed English field names. `siteIds` is the report's site scope
 * (report-scope.ts): null covers every site, an array only stations at those
 * sites (no unsited stations; an empty array yields an empty report). Every
 * query of the generator honours it, on top of the filters.
 */
export type ReportGenerator = (
  filters: Record<string, unknown>,
  format: string,
  language: UiLanguage,
  siteIds: ReportSiteScope,
  access: ReportColumnAccess,
) => Promise<ReportGeneratorResult>;

/**
 * Which columns the report's reader may see: driver
 * identity (name, email, phone, token id) needs drivers:read, money (cost,
 * revenue, tax, payment, refund, spend) payments:read. A report keeps working
 * for anyone who may run it and leaves out the columns its reader cannot see.
 * The reader is the requesting user, or the schedule owner for a scheduled run
 * (`reportColumnAccess` in report-scope.ts).
 */
export interface ReportColumnAccess {
  driverData: boolean;
  money: boolean;
}

/** A reader who may see every column. */
export const FULL_REPORT_COLUMN_ACCESS: ReportColumnAccess = { driverData: true, money: true };

/** What a column shows: driver identity, money, or neither. */
export type ReportColumnKind = 'driver' | 'money';

/** Whether a reader with `access` may see a column of `kind`. */
export function columnVisible(
  kind: ReportColumnKind | undefined,
  access: ReportColumnAccess,
): boolean {
  if (kind === 'driver') return access.driverData;
  if (kind === 'money') return access.money;
  return true;
}

export interface ReportGeneratorDescriptor {
  type: string;
  generate: ReportGenerator;
  /** Formats the generator writes. A request for another format gets the first one. */
  formats: readonly ReportFormat[];
  /** Whether the CSMS Generate and Schedules tabs offer the type. */
  generateFromUi: boolean;
  /** Why the filters cannot produce this report, or null when they can. */
  validateFilters?: (filters: Record<string, unknown>) => string | null;
  /**
   * Permissions the report needs on top of `reports:*`, because its content
   * is what those permissions guard (revenue: `payments:read`; driver names,
   * emails and spend: `drivers:read`). Checked on generate, on schedule create
   * and edit, on run now and for the creator at each scheduled run.
   */
  requiredPermissions?: readonly string[];
}

export class ReportGeneratorRegistry {
  private readonly descriptors = new Map<string, ReportGeneratorDescriptor>();

  register(descriptor: ReportGeneratorDescriptor): void {
    if (this.descriptors.has(descriptor.type)) {
      throw new Error(`Report generator ${descriptor.type} is already registered`);
    }
    if (descriptor.formats.length === 0) {
      throw new Error(`Report generator ${descriptor.type} has no format`);
    }
    this.descriptors.set(descriptor.type, descriptor);
  }

  get(type: string): ReportGeneratorDescriptor | undefined {
    return this.descriptors.get(type);
  }

  list(): ReportGeneratorDescriptor[] {
    return [...this.descriptors.values()];
  }
}
