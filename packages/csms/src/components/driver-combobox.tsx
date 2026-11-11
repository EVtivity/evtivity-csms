// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox, SearchComboboxSelection } from '@/components/ui/search-combobox';
import { api } from '@/lib/api';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface DriverListResponse {
  data: Driver[];
  total: number;
}

interface DriverComboboxProps {
  /** The input id, so a `Label htmlFor` names the field. */
  id?: string | undefined;
  /** Draws the field border in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  value: { id: string; name: string } | null;
  onSelect: (driver: { id: string; name: string } | null) => void;
}

export function DriverCombobox({
  id,
  invalid,
  value,
  onSelect,
}: DriverComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<Driver[]>([]);

  useEffect(() => {
    if (input.length === 0) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: input, limit: '10', page: '1' });
      void api.get<DriverListResponse>(`/v1/drivers?${params.toString()}`).then((res) => {
        setResults(res.data);
      });
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [input]);

  if (value) {
    return (
      <SearchComboboxSelection
        id={id}
        value={value.name}
        invalid={invalid}
        aria-label={id == null ? t('tokens.driver') : undefined}
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
      items={input.length === 0 ? [] : results}
      getKey={(driver) => driver.id}
      placeholder={t('tokens.searchDrivers')}
      aria-label={t('tokens.searchDrivers')}
      onSelect={(driver) => {
        onSelect({ id: driver.id, name: `${driver.firstName} ${driver.lastName}` });
        setInput('');
      }}
      renderItem={(driver) => (
        <>
          <span className="font-medium">
            {driver.firstName} {driver.lastName}
          </span>
          {driver.email && <span className="ml-2 text-muted-foreground">{driver.email}</span>}
        </>
      )}
    />
  );
}
