// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AI_STATUS_KEY } from '@/components/ai/use-ai-status';
import { api } from '@/lib/api';

export type Values = Record<string, string>;

/** Writes only the keys whose value changed, through the generic settings PUT. */
export function useSaveKeys(
  keys: readonly string[],
  loaded: Values,
  toValue: (key: string, v: string) => unknown,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: Values) => {
      const changed = keys.filter(
        (k) => toValue(k, values[k] ?? '') !== toValue(k, loaded[k] ?? ''),
      );
      for (const key of changed) {
        await api.put(`/v1/settings/${key}`, { value: toValue(key, values[key] ?? '') });
      }
    },
    // Settled: keys written before a failed one are saved, so reload either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });
}
