// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { SearchCombobox } from '@/components/ui/search-combobox';
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
  value: { id: string; name: string } | null;
  onSelect: (driver: { id: string; name: string } | null) => void;
}

export function DriverCombobox({ value, onSelect }: DriverComboboxProps): React.JSX.Element {
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
      <div className="flex items-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-3 py-1 text-sm font-medium">
          {value.name}
          <button
            type="button"
            aria-label={t('common.clear')}
            className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              onSelect(null);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <SearchCombobox
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
