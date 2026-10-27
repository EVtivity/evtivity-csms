// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { defaultDashboardLayout, type DashboardLayout } from '@evtivity/lib/dashboard-layout';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

export const DASHBOARD_LAYOUT_QUERY_KEY = ['dashboard-layout'] as const;
const LAYOUT_URL = '/v1/users/me/dashboard-layout';
const SAVE_KEY = ['dashboard-layout', 'save'] as const;

interface LayoutReply {
  layout: DashboardLayout;
  customized: boolean;
}

export interface DashboardLayoutState {
  /** The layout to render; null while the saved layout loads. */
  layout: DashboardLayout | null;
  /** True when the user saved a layout. */
  customized: boolean;
  /** Saves the whole layout (shown at once, rolled back with a toast when the save fails). */
  save: (layout: DashboardLayout) => void;
  /** Returns to the default layout. */
  reset: () => void;
  isResetting: boolean;
}

/**
 * The Live dashboard layout of the signed-in user, saved on the server. A
 * failed load falls back to the default layout, so the dashboard never waits
 * on it; a failed save keeps the layout shown before and says so.
 */
export function useDashboardLayout(): DashboardLayoutState {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: DASHBOARD_LAYOUT_QUERY_KEY,
    queryFn: () => api.get<LayoutReply>(LAYOUT_URL),
    staleTime: Infinity,
  });

  // Several moves in a row send several saves: only the last one to settle
  // writes its reply (or its rollback) into the cache, so an earlier reply
  // never undoes a later move.
  const isLastSave = (): boolean => queryClient.isMutating({ mutationKey: SAVE_KEY }) <= 1;

  const saveMutation = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: (layout: DashboardLayout) => api.put<LayoutReply>(LAYOUT_URL, layout),
    onMutate: async (layout) => {
      await queryClient.cancelQueries({ queryKey: DASHBOARD_LAYOUT_QUERY_KEY });
      const previous = queryClient.getQueryData<LayoutReply>(DASHBOARD_LAYOUT_QUERY_KEY);
      queryClient.setQueryData<LayoutReply>(DASHBOARD_LAYOUT_QUERY_KEY, {
        layout,
        customized: true,
      });
      return { previous };
    },
    onError: (_err, _layout, context) => {
      if (isLastSave()) {
        queryClient.setQueryData(DASHBOARD_LAYOUT_QUERY_KEY, context?.previous);
      } else {
        void queryClient.invalidateQueries({ queryKey: DASHBOARD_LAYOUT_QUERY_KEY });
      }
      toast({ title: t('dashboard.layoutSaveFailed'), variant: 'destructive' });
    },
    onSuccess: (reply) => {
      if (isLastSave()) queryClient.setQueryData(DASHBOARD_LAYOUT_QUERY_KEY, reply);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.delete<LayoutReply>(LAYOUT_URL),
    onSuccess: (reply) => {
      queryClient.setQueryData(DASHBOARD_LAYOUT_QUERY_KEY, reply);
    },
    onError: () => {
      toast({ title: t('dashboard.layoutSaveFailed'), variant: 'destructive' });
    },
  });

  const layout = query.data?.layout ?? (query.isError ? defaultDashboardLayout() : null);
  return {
    layout,
    customized: query.data?.customized ?? false,
    save: (next) => {
      saveMutation.mutate(next);
    },
    reset: () => {
      resetMutation.mutate();
    },
    isResetting: resetMutation.isPending,
  };
}
