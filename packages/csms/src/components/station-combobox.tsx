// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SearchCombobox } from '@/components/ui/search-combobox';
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
      <div className="relative">
        <Input id={id} value={value.stationId} readOnly className="pr-9 cursor-default" />
        <button
          type="button"
          aria-label={t('common.clear')}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            onSelect(null);
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
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
