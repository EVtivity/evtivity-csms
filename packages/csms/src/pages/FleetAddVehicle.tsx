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

interface SearchableVehicle {
  id: string;
  driverId: string;
  driverName: string;
  make: string | null;
  model: string | null;
  year: string | null;
  licensePlate: string | null;
}

export function FleetAddVehicle(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [search, setSearch] = useState('');
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const { data: searchResults } = useQuery({
    queryKey: ['fleets', id, 'vehicles', 'available', search],
    queryFn: () =>
      api.get<SearchableVehicle[]>(
        `/v1/fleets/${id ?? ''}/vehicles/available?search=${search}&limit=10`,
      ),
    enabled: search.length > 0,
  });

  const addDriverMutation = useMutation({
    mutationFn: (driverId: string) => api.post(`/v1/fleets/${id ?? ''}/drivers`, { driverId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', id, 'drivers'] });
      void queryClient.invalidateQueries({ queryKey: ['fleets', id, 'vehicles'] });
      void navigate(`/fleets/${id ?? ''}?tab=vehicles`);
    },
    onSettled: () => {
      setMutatingId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/fleets/${id ?? ''}?tab=vehicles`} />
        <h1 className="text-2xl md:text-3xl font-bold">{t('fleets.addVehicle')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('fleets.searchVehiclesPlaceholder')}
            className="w-full"
          />

          {addDriverMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(addDriverMutation.error, t)}
            </p>
          )}

          <div className="space-y-1">
            {search.length > 0 && searchResults != null && searchResults.length > 0
              ? searchResults.map((vehicle) => (
                  <button
                    key={vehicle.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => {
                      setMutatingId(vehicle.id);
                      addDriverMutation.mutate(vehicle.driverId);
                    }}
                    disabled={addDriverMutation.isPending}
                  >
                    {mutatingId === vehicle.id && addDriverMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    )}
                    <span>
                      {vehicle.make} {vehicle.model}
                    </span>
                    {vehicle.year != null && (
                      <span className="text-muted-foreground">{vehicle.year}</span>
                    )}
                    {vehicle.licensePlate != null && (
                      <span className="text-muted-foreground">{vehicle.licensePlate}</span>
                    )}
                    <span className="text-muted-foreground ml-auto">{vehicle.driverName}</span>
                  </button>
                ))
              : search.length > 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('fleets.noVehicleResults')}
                  </p>
                )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
