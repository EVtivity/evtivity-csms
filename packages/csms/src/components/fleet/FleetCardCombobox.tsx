// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox, SearchComboboxSelection } from '@/components/ui/search-combobox';
import { api } from '@/lib/api';

export interface FleetCardSelection {
  id: string;
  name: string;
}

interface FleetCardOption {
  id: string;
  idToken: string;
  label: string | null;
}

interface FleetCardComboboxProps {
  id: string;
  fleetId: string;
  value: FleetCardSelection | null;
  onSelect: (card: FleetCardSelection | null) => void;
}

/** The card value, with its label when it has one. */
export function fleetCardName(card: { idToken: string; label: string | null }): string {
  return card.label != null && card.label !== '' ? `${card.label} (${card.idToken})` : card.idToken;
}

/** Search the RFID cards of a fleet by value or label and pick one, or clear the pick. */
export function FleetCardCombobox({
  id,
  fleetId,
  value,
  onSelect,
}: FleetCardComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<FleetCardOption[]>([]);

  useEffect(() => {
    if (input.trim().length === 0) {
      setResults([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: input.trim(), limit: '10', page: '1' });
      api
        .get<{ data: FleetCardOption[]; total: number }>(
          `/v1/fleets/${fleetId}/cards?${params.toString()}`,
        )
        .then((res) => {
          if (current) setResults(res.data);
        })
        .catch((err: unknown) => {
          console.warn('Fleet RFID card search failed', err);
          if (current) setResults([]);
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [input, fleetId]);

  if (value != null) {
    return (
      <SearchComboboxSelection
        id={id}
        value={value.name}
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
      query={input}
      onQueryChange={setInput}
      items={input.trim().length === 0 ? [] : results}
      getKey={(card) => card.id}
      placeholder={t('fleets.sessionFilters.searchCards')}
      aria-label={t('fleets.sessionFilters.searchCards')}
      onSelect={(card) => {
        onSelect({ id: card.id, name: fleetCardName(card) });
        setInput('');
      }}
      renderItem={(card) => (
        <span className="font-medium wrap-anywhere">{fleetCardName(card)}</span>
      )}
    />
  );
}
