// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox, SearchComboboxSelection } from '@/components/ui/search-combobox';
import { api } from '@/lib/api';

export interface FleetSelection {
  id: string;
  name: string;
}

interface FleetComboboxProps {
  /** The input id, so a `Label htmlFor` names the field. */
  id?: string | undefined;
  value: FleetSelection | null;
  onSelect: (fleet: FleetSelection | null) => void;
  /** Fleets left out of the results (those already picked). */
  excludeIds?: readonly string[] | undefined;
}

/** Search the fleets by name and pick one: every fleet is reachable, not only a first page. */
export function FleetCombobox({
  id,
  value,
  onSelect,
  excludeIds,
}: FleetComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<FleetSelection[]>([]);

  useEffect(() => {
    if (input.trim().length === 0) {
      setResults([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: input.trim(), limit: '10', page: '1' });
      api
        .get<{ data: FleetSelection[]; total: number }>(`/v1/fleets?${params.toString()}`)
        .then((res) => {
          if (current) setResults(res.data.map((f) => ({ id: f.id, name: f.name })));
        })
        .catch((err: unknown) => {
          console.warn('Fleet search failed', err);
          if (current) setResults([]);
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [input]);

  if (value != null) {
    return (
      <SearchComboboxSelection
        id={id}
        value={value.name}
        aria-label={id == null ? t('tokens.fleet') : undefined}
        clearLabel={t('common.clear')}
        onClear={() => {
          onSelect(null);
        }}
      />
    );
  }

  const excluded = new Set(excludeIds ?? []);
  return (
    <SearchCombobox
      id={id}
      query={input}
      onQueryChange={setInput}
      items={input.trim().length === 0 ? [] : results.filter((f) => !excluded.has(f.id))}
      getKey={(fleet) => fleet.id}
      placeholder={t('fleets.searchFleets')}
      aria-label={t('fleets.searchFleets')}
      onSelect={(fleet) => {
        onSelect(fleet);
        setInput('');
      }}
      renderItem={(fleet) => <span className="font-medium">{fleet.name}</span>}
    />
  );
}
