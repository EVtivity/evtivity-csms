// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback } from 'react';

interface DateRangeState {
  days: number;
  customFrom: string | null;
  customTo: string | null;
  dateQuery: string;
  handlePreset: (days: number) => void;
  handleCustom: (from: string, to: string) => void;
}

export function useDateRange(defaultDays = 7): DateRangeState {
  const [days, setDays] = useState(defaultDays);
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  const dateQuery =
    customFrom && customTo ? `from=${customFrom}&to=${customTo}` : `days=${String(days)}`;

  const handlePreset = useCallback((d: number) => {
    setDays(d);
    setCustomFrom(null);
    setCustomTo(null);
  }, []);

  const handleCustom = useCallback((from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
  }, []);

  return { days, customFrom, customTo, dateQuery, handlePreset, handleCustom };
}
