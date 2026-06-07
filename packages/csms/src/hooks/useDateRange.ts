// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback } from 'react';
import { presetRange } from '@/lib/date-range';

interface DateRangeState {
  days: number;
  customFrom: string | null;
  customTo: string | null;
  dateQuery: string;
  /** Concrete range the current selection covers, custom or preset-derived. */
  effectiveFrom: string;
  effectiveTo: string;
  handlePreset: (days: number) => void;
  handleCustom: (from: string, to: string) => void;
}

export function useDateRange(defaultDays = 7): DateRangeState {
  const [days, setDays] = useState(defaultDays);
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  const dateQuery =
    customFrom && customTo ? `from=${customFrom}&to=${customTo}` : `days=${String(days)}`;

  const derived = presetRange(days);
  const effectiveFrom = customFrom ?? derived.from;
  const effectiveTo = customTo ?? derived.to;

  const handlePreset = useCallback((d: number) => {
    setDays(d);
    setCustomFrom(null);
    setCustomTo(null);
  }, []);

  const handleCustom = useCallback((from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
  }, []);

  return {
    days,
    customFrom,
    customTo,
    dateQuery,
    effectiveFrom,
    effectiveTo,
    handlePreset,
    handleCustom,
  };
}
