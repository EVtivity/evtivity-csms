// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SearchInput } from '@/components/search-input';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface SearchableStation {
  id: string;
  stationId: string;
  model: string | null;
}

export function FleetAddStation(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [search, setSearch] = useState('');
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const { data: searchResults } = useQuery({
    queryKey: ['stations', 'search', search],
    queryFn: () => api.get<{ data: SearchableStation[] }>(`/v1/stations?search=${search}&limit=10`),
    enabled: search.length > 0,
  });

  const addStationMutation = useMutation({
    mutationFn: (stationId: string) => api.post(`/v1/fleets/${id ?? ''}/stations`, { stationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', id, 'stations'] });
      void navigate(`/fleets/${id ?? ''}?tab=stations`);
    },
    onSettled: () => {
      setMutatingId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/fleets/${id ?? ''}?tab=stations`} />
        <h1 className="text-2xl md:text-3xl font-bold">{t('fleets.addStation')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('fleets.searchStationsPlaceholder')}
            className="w-full"
          />

          {addStationMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(addStationMutation.error, t)}
            </p>
          )}

          <div className="space-y-1">
            {search.length > 0 && searchResults?.data != null && searchResults.data.length > 0
              ? searchResults.data.map((station) => (
                  <button
                    key={station.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => {
                      setMutatingId(station.id);
                      addStationMutation.mutate(station.id);
                    }}
                    disabled={addStationMutation.isPending}
                  >
                    {mutatingId === station.id && addStationMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    )}
                    <span>{station.stationId}</span>
                    {station.model != null && (
                      <span className="text-muted-foreground">{station.model}</span>
                    )}
                  </button>
                ))
              : search.length > 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('fleets.noStationResults')}
                  </p>
                )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
