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

interface SearchableDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

export function FleetAddDriver(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [search, setSearch] = useState('');
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const { data: searchResults } = useQuery({
    queryKey: ['drivers', 'search', search],
    queryFn: () => api.get<{ data: SearchableDriver[] }>(`/v1/drivers?search=${search}&limit=10`),
    enabled: search.length > 0,
  });

  const addDriverMutation = useMutation({
    mutationFn: (driverId: string) => api.post(`/v1/fleets/${id ?? ''}/drivers`, { driverId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', id, 'drivers'] });
      void queryClient.invalidateQueries({ queryKey: ['fleets', id, 'vehicles'] });
      void navigate(`/fleets/${id ?? ''}?tab=drivers`);
    },
    onSettled: () => {
      setMutatingId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/fleets/${id ?? ''}?tab=drivers`} />
        <h1 className="text-2xl font-bold md:text-3xl">{t('fleets.addDriver')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('fleets.searchDriversPlaceholder')}
            className="w-full"
          />

          {addDriverMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(addDriverMutation.error, t)}
            </p>
          )}

          <div className="space-y-1">
            {search.length > 0 && searchResults?.data != null && searchResults.data.length > 0
              ? searchResults.data.map((driver) => (
                  <button
                    key={driver.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => {
                      setMutatingId(driver.id);
                      addDriverMutation.mutate(driver.id);
                    }}
                    disabled={addDriverMutation.isPending}
                  >
                    {mutatingId === driver.id && addDriverMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    )}
                    <span>
                      {driver.firstName} {driver.lastName}
                    </span>
                    {driver.email != null && (
                      <span className="text-muted-foreground">{driver.email}</span>
                    )}
                  </button>
                ))
              : search.length > 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('fleets.noDriverResults')}
                  </p>
                )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
