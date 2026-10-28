// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { PricingGroup } from '@/lib/types';

export interface PricingGroupPickListProps {
  groups: PricingGroup[] | undefined;
  /** The group assigned now: shown highlighted with a Current badge and not selectable. */
  currentGroupId: string | null | undefined;
  /** The group being assigned, which shows a spinner. */
  pendingGroupId: string | null;
  isPending: boolean;
  emptyLabel: string;
  onSelect: (group: PricingGroup) => void;
}

/** The list of pricing groups on the Assign Pricing Group pages (station, site, driver, fleet). */
export function PricingGroupPickList({
  groups,
  currentGroupId,
  pendingGroupId,
  isPending,
  emptyLabel,
  onSelect,
}: PricingGroupPickListProps): React.JSX.Element {
  const { t } = useTranslation();

  if (groups == null || groups.length === 0) {
    return (
      <div className="space-y-1">
        <p className="px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  const currentReason = t('pricing.currentGroupNotSelectable');

  return (
    <div className="space-y-1">
      {groups.map((group) => {
        const isCurrent = currentGroupId != null && group.id === currentGroupId;
        return (
          <button
            key={group.id}
            type="button"
            data-testid={`pricing-group-option-${group.id}`}
            className={cn(
              'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors',
              isCurrent
                ? 'cursor-not-allowed bg-accent text-accent-foreground'
                : 'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
            )}
            onClick={() => {
              if (!isCurrent) onSelect(group);
            }}
            disabled={isCurrent || isPending}
            aria-disabled={isCurrent || isPending}
            aria-current={isCurrent ? 'true' : undefined}
            title={isCurrent ? currentReason : undefined}
          >
            {pendingGroupId === group.id && isPending && <Spinner className="h-4 w-4 shrink-0" />}
            <span className="font-medium">{group.name}</span>
            {group.description != null && (
              <span className="text-muted-foreground">{group.description}</span>
            )}
            {isCurrent && (
              <Badge variant="default" className="ml-auto shrink-0">
                {t('pricing.currentGroup')}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
