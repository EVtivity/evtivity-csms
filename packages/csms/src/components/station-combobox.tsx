// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox, SearchComboboxSelection } from '@/components/ui/search-combobox';
import { api } from '@/lib/api';

interface Station {
  id: string;
  stationId: string;
  isOnline: boolean;
}

interface StationListResponse {
  data: Station[];
  total: number;
}

export interface StationSelection {
  id: string;
  stationId: string;
}

interface StationComboboxProps {
  /** The input id, so a `Label htmlFor` names the field. */
  id?: string | undefined;
  /** Draws the field border in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  value: StationSelection | null;
  onSelect: (station: StationSelection | null) => void;
  siteId?: string | undefined;
  // Hide stations whose id is in this set. Used by the bulk reservation flow
  // to prevent the same station appearing in two slots.
  excludeIds?: ReadonlySet<string> | undefined;
}

export function StationCombobox({
  id,
  invalid,
  value,
  onSelect,
  siteId,
  excludeIds,
}: StationComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<Station[]>([]);

  useEffect(() => {
    if (input.length === 0) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: input, limit: '10', page: '1' });
      if (siteId != null && siteId !== '') params.set('siteId', siteId);
      void api.get<StationListResponse>(`/v1/stations?${params.toString()}`).then((res) => {
        setResults(res.data);
      });
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [input, siteId]);

  const filteredResults =
    input.length === 0
      ? []
      : excludeIds == null
        ? results
        : results.filter((s) => !excludeIds.has(s.id));

  if (value) {
    return (
      <SearchComboboxSelection
        id={id}
        value={value.stationId}
        invalid={invalid}
        clearLabel={t('common.clear')}
        onClear={() => {
          onSelect(null);
        }}
      />
    );
  }

  return (
    <SearchCombobox
      id={id}
      invalid={invalid}
      query={input}
      onQueryChange={setInput}
      items={filteredResults}
      getKey={(station) => station.id}
      placeholder={t('stations.searchPlaceholder')}
      onSelect={(station) => {
        onSelect({ id: station.id, stationId: station.stationId });
        setInput('');
      }}
      renderItem={(station) => (
        <>
          <span className="font-medium">{station.stationId}</span>
          <span
            className={`ml-2 inline-block h-2 w-2 rounded-full ${station.isOnline ? 'bg-success' : 'bg-muted-foreground'}`}
          />
        </>
      )}
    />
  );
}
