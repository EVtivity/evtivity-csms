// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
import { LoadingLogo } from '@/components/loading-logo';

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
      <Card>
        <CardContent className="overflow-x-auto p-0">
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
                    <LoadingLogo size="inline" />
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
                      <Checkbox
                        checked={loc.isPublished}
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
        </CardContent>
      </Card>
    </div>
  );
}
