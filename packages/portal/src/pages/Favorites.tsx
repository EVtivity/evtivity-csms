// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

interface FavoriteStation {
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

export function Favorites(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [removeTarget, setRemoveTarget] = useState<FavoriteStation | null>(null);

  const { data: favorites, isLoading } = useQuery({
    queryKey: ['portal-favorites'],
    queryFn: () => api.get<FavoriteStation[]>('/v1/portal/favorites'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/portal/favorites/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-favorites'] });
      void queryClient.invalidateQueries({ queryKey: ['favorite-check'] });
      setRemoveTarget(null);
      toast({ variant: 'success', title: t('favorites.removed') });
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('favorites.title')} />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!isLoading && (favorites == null || favorites.length === 0) && (
        <p className="text-sm text-muted-foreground">{t('favorites.noFavorites')}</p>
      )}

      <div className="space-y-3">
        {favorites?.map((fav) => (
          <div
            key={fav.id}
            className="flex items-center justify-between rounded-lg border p-4 cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => {
              void navigate(`/start/${fav.stationId}`);
            }}
          >
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold truncate">{fav.stationId}</span>
                <div
                  className={`h-2 w-2 rounded-full shrink-0 ${fav.isOnline ? 'bg-success' : 'bg-destructive'}`}
                />
              </div>
              {fav.siteName != null && (
                <p className="text-xs text-muted-foreground truncate">{fav.siteName}</p>
              )}
              {fav.siteAddress != null && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {fav.siteAddress}
                    {fav.siteCity != null && `, ${fav.siteCity}`}
                    {fav.siteState != null && `, ${fav.siteState}`}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('favorites.connectors', {
                  available: fav.availableCount,
                  total: fav.evseCount,
                })}
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRemoveTarget(fav);
              }}
              className="shrink-0 ml-3 h-12 w-12 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive transition-colors"
              aria-label={t('favorites.removeFromFavorites')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('favorites.confirmRemoveTitle')}
        description={t('favorites.confirmRemoveDescription')}
        confirmLabel={t('favorites.removeFromFavorites')}
        variant="destructive"
        onConfirm={() => {
          if (removeTarget != null) {
            removeMutation.mutate(removeTarget.id);
          }
        }}
        isPending={removeMutation.isPending}
      />
    </div>
  );
}
