// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ReportTypeInfo {
  type: string;
  formats: string[];
  generateFromUi: boolean;
}

export interface ReportTypes {
  /** Every report type, for listing and filtering reports. */
  all: ReportTypeInfo[];
  /** The types the Generate and Schedules tabs offer. */
  offered: ReportTypeInfo[];
  /** True when the types could not be loaded; the lists are then empty. */
  isError: boolean;
  /** Loads the types again after an error. */
  refetch: () => void;
}

const EMPTY: ReportTypeInfo[] = [];
const EMPTY_FORMATS: string[] = [];

/** The report types the server registers. They change only when the server restarts. */
export function useReportTypes(): ReportTypes {
  const { data, isError, refetch } = useQuery({
    queryKey: ['report-types'],
    queryFn: () => api.get<ReportTypeInfo[]>('/v1/reports/types'),
    staleTime: Infinity,
  });
  const all = data ?? EMPTY;
  return {
    all,
    offered: all.filter((t) => t.generateFromUi),
    isError,
    refetch: () => {
      void refetch();
    },
  };
}

/** The formats a report type is written in; none for an unknown type. */
export function reportTypeFormats(types: ReportTypeInfo[], type: string): string[] {
  return types.find((t) => t.type === type)?.formats ?? EMPTY_FORMATS;
}
