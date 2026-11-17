// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchCombobox, SearchComboboxSelection } from '@/components/ui/search-combobox';
import { api } from '@/lib/api';

export interface FleetMemberSelection {
  id: string;
  name: string;
}

interface FleetMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

interface FleetMemberComboboxProps {
  id: string;
  fleetId: string;
  /** The member the card goes to, null for no member. */
  value: FleetMemberSelection | null;
  onSelect: (member: FleetMemberSelection | null) => void;
  /** Offer only active members (default); false also offers inactive ones, such as for a filter. */
  activeOnly?: boolean;
}

export function fleetMemberName(member: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim();
}

/** Search the active members of a fleet by name and pick one, or clear the pick for no member. */
export function FleetMemberCombobox({
  id,
  fleetId,
  value,
  onSelect,
  activeOnly = true,
}: FleetMemberComboboxProps): React.JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<FleetMember[]>([]);

  useEffect(() => {
    if (input.trim().length === 0) {
      setResults([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        search: input.trim(),
        limit: '10',
        page: '1',
      });
      if (activeOnly) params.set('active', 'true');
      api
        .get<{ data: FleetMember[]; total: number }>(
          `/v1/fleets/${fleetId}/drivers?${params.toString()}`,
        )
        .then((res) => {
          if (current) setResults(res.data);
        })
        .catch((err: unknown) => {
          console.warn('Fleet member search failed', err);
          if (current) setResults([]);
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [input, fleetId, activeOnly]);

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
      getKey={(member) => member.id}
      placeholder={t('fleets.cards.searchMembers')}
      aria-label={t('fleets.cards.searchMembers')}
      onSelect={(member) => {
        onSelect({ id: member.id, name: fleetMemberName(member) });
        setInput('');
      }}
      renderItem={(member) => <span className="font-medium">{fleetMemberName(member)}</span>}
    />
  );
}
