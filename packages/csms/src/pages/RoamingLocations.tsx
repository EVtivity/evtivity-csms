// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useHasPermission } from '@/lib/auth';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/ui/toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';

interface LocationPublishInfo {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  isPublished: boolean;
  publishToAll: boolean;
  ocpiLocationId: string | null;
}

export function RoamingLocations(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasPermission('roaming:write');

  const {
    data: locations,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['ocpi-locations'],
    queryFn: () => api.get<LocationPublishInfo[]>('/v1/ocpi/locations'),
  });

  const toggleMutation = useMutation({
    mutationFn: (data: { siteId: string; isPublished: boolean }) =>
      api.put(`/v1/ocpi/locations/${data.siteId}`, { isPublished: data.isPublished }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-locations'] });
    },
    onError: (err: unknown) => {
      const message =
        err != null && typeof err === 'object' && 'body' in err
          ? ((err as { body: { error?: string } }).body.error ?? t('common.requestFailed'))
          : t('common.requestFailed');
      toast({ variant: 'destructive', title: message });
    },
  });

  return (
    <div className="space-y-6">
      <TabPanel title={t('nav.roamingLocations')} body="flush">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('roaming.locations.locationName')}</TableHead>
                <TableHead>{t('roaming.locations.address')}</TableHead>
                <TableHead>{t('roaming.locations.published')}</TableHead>
                <TableHead>{t('roaming.locations.visibility')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableStateRow colSpan={4}>
                  <LoadingState />
                </TableStateRow>
              ) : isError ? (
                <TableStateRow colSpan={4}>
                  <ErrorState
                    onRetry={() => {
                      void refetch();
                    }}
                  />
                </TableStateRow>
              ) : locations == null || locations.length === 0 ? (
                <TableStateRow colSpan={4}>
                  <EmptyState>{t('roaming.locations.noLocations')}</EmptyState>
                </TableStateRow>
              ) : (
                locations.map((loc) => (
                  <TableRow key={loc.id}>
                    <TableCell className="font-medium">{loc.name}</TableCell>
                    <TableCell>
                      {[loc.address, loc.city, loc.country].filter(Boolean).join(', ') || '-'}
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        checked={loc.isPublished}
                        disabled={!canWrite}
                        aria-label={t('roaming.locations.published')}
                        onChange={(e) => {
                          toggleMutation.mutate({ siteId: loc.id, isPublished: e.target.checked });
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {loc.isPublished ? (
                        <Badge variant={loc.publishToAll ? 'default' : 'secondary'}>
                          {loc.publishToAll
                            ? t('roaming.locations.allPartners')
                            : t('roaming.locations.selectedPartners')}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabPanel>
    </div>
  );
}
