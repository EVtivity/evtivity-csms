// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Search, X } from 'lucide-react';
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
  value: StationSelection | null;
  onSelect: (station: StationSelection | null) => void;
  siteId?: string | undefined;
}

export function StationCombobox({
  value,
  onSelect,
  siteId,
}: StationComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<Station[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || input.length === 0) {
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
  }, [input, open, siteId]);

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
      <div className="relative">
        <Input value={value.stationId} readOnly className="pr-9 cursor-default" />
        <button
          type="button"
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
        placeholder={t('stations.searchPlaceholder')}
        className="pl-9"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md max-h-48 overflow-y-auto">
          {results.map((station) => (
            <li key={station.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onSelect({ id: station.id, stationId: station.stationId });
                  setInput('');
                  setOpen(false);
                }}
              >
                <span className="font-medium">{station.stationId}</span>
                <span
                  className={`ml-2 inline-block h-2 w-2 rounded-full ${station.isOnline ? 'bg-success' : 'bg-muted-foreground'}`}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
