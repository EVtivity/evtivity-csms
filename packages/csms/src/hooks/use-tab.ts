// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useSearchParams } from 'react-router-dom';
import { useCallback } from 'react';

export function useTab(
  defaultTab: string,
  paramName = 'tab',
  clearParams?: string[],
): [string, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get(paramName) ?? defaultTab;

  const setTab = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === defaultTab) {
            next.delete(paramName);
          } else {
            next.set(paramName, value);
          }
          if (clearParams) {
            for (const p of clearParams) {
              next.delete(p);
            }
          }
          return next;
        },
        { replace: true },
      );
    },
    [defaultTab, paramName, clearParams, setSearchParams],
  );

  return [tab, setTab];
}
