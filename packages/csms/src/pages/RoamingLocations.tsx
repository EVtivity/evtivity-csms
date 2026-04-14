// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';

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

  const { data: locations, isLoading } = useQuery({
    queryKey: ['ocpi-locations'],
    queryFn: () => api.get<LocationPublishInfo[]>('/v1/ocpi/locations'),
  });

  const toggleMutation = useMutation({
    mutationFn: (data: { siteId: string; isPublished: boolean }) =>
      api.put(`/v1/ocpi/locations/${data.siteId}`, { isPublished: data.isPublished }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-locations'] });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('roaming.locations.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('roaming.locations.description')}</p>

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
            <TableRow>
              <TableCell colSpan={4} className="text-center">
                {t('common.loading')}
              </TableCell>
            </TableRow>
          ) : locations == null || locations.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {t('roaming.locations.noLocations')}
              </TableCell>
            </TableRow>
          ) : (
            locations.map((loc) => (
              <TableRow key={loc.id}>
                <TableCell className="font-medium">{loc.name}</TableCell>
                <TableCell>
                  {[loc.address, loc.city, loc.country].filter(Boolean).join(', ') || '-'}
                </TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={loc.isPublished}
                    onChange={(e) => {
                      toggleMutation.mutate({ siteId: loc.id, isPublished: e.target.checked });
                    }}
                    className="h-4 w-4 rounded border-gray-300"
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
  );
}
