// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Search, X } from 'lucide-react';
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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || input.length === 0) {
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
  }, [input, open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  if (value) {
    return (
      <div className="flex items-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-3 py-1 text-sm font-medium">
          {value.name}
          <button
            type="button"
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
    <div ref={containerRef} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (input.length > 0) setOpen(true);
        }}
        placeholder={t('tokens.searchDrivers')}
        className="pl-9"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md max-h-48 overflow-y-auto">
          {results.map((driver) => (
            <li key={driver.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onSelect({
                    id: driver.id,
                    name: `${driver.firstName} ${driver.lastName}`,
                  });
                  setInput('');
                  setOpen(false);
                }}
              >
                <span className="font-medium">
                  {driver.firstName} {driver.lastName}
                </span>
                {driver.email && <span className="ml-2 text-muted-foreground">{driver.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
