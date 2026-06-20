// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

interface WatchStation {
  id: number;
  stationId: string;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  isOnline: boolean;
  evseCount: number;
  availableCount: number;
}

export function Watching(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);

  const { data: watches, isLoading } = useQuery({
    queryKey: ['portal-station-watches'],
    queryFn: () => api.get<WatchStation[]>('/v1/portal/station-watches'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/portal/station-watches/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-station-watches'] });
      void queryClient.invalidateQueries({ queryKey: ['station-watch-check'] });
      toast({ variant: 'success', title: t('watch.removed') });
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('watch.title')} />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!isLoading && (watches == null || watches.length === 0) && (
        <p className="text-center text-sm text-muted-foreground">{t('watch.empty')}</p>
      )}

      <div className="space-y-3">
        {watches?.map((w) => (
          <div
            key={w.id}
            className="flex items-center justify-between rounded-lg border p-4 cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => {
              void navigate(`/start/${w.stationId}`);
            }}
          >
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold truncate">{w.stationId}</span>
                <div
                  className={`h-2 w-2 rounded-full shrink-0 ${w.isOnline ? 'bg-success' : 'bg-destructive'}`}
                />
              </div>
              {w.siteName != null && (
                <p className="text-xs text-muted-foreground truncate">{w.siteName}</p>
              )}
              {w.siteAddress != null && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {w.siteAddress}
                    {w.siteCity != null && `, ${w.siteCity}`}
                    {w.siteState != null && `, ${w.siteState}`}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('favorites.connectors', {
                  available: w.availableCount,
                  total: w.evseCount,
                })}
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPendingRemove(w.id);
              }}
              disabled={removeMutation.isPending}
              className="shrink-0 ml-3 h-12 w-12 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive transition-colors"
              aria-label={t('common.remove')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={t('watch.removeTitle')}
        description={t('watch.removeMessage')}
        confirmLabel={t('common.remove')}
        variant="destructive"
        isPending={removeMutation.isPending}
        onConfirm={() => {
          if (pendingRemove != null) removeMutation.mutate(pendingRemove);
          setPendingRemove(null);
        }}
      />
    </div>
  );
}
