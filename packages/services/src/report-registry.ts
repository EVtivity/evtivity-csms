// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { UiLanguage } from '@evtivity/lib/languages';

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
 * has fixed English field names.
 */
export type ReportGenerator = (
  filters: Record<string, unknown>,
  format: string,
  language: UiLanguage,
) => Promise<ReportGeneratorResult>;

export interface ReportGeneratorDescriptor {
  type: string;
  generate: ReportGenerator;
  /** Formats the generator writes. A request for another format gets the first one. */
  formats: readonly ReportFormat[];
  /** Whether the CSMS Generate and Schedules tabs offer the type. */
  generateFromUi: boolean;
  /** Why the filters cannot produce this report, or null when they can. */
  validateFilters?: (filters: Record<string, unknown>) => string | null;
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
