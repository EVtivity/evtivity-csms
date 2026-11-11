// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { ListSort, ListSortOrder } from '@/hooks/use-list-sort';

interface SortableTableHeadProps<K extends string> extends Omit<
  React.ThHTMLAttributes<HTMLTableCellElement>,
  'children'
> {
  /** The API sort key of this column. */
  sortKey: K;
  /**
   * The table's sort, from `useListSort`. Without it the header is a plain `TableHead`, for
   * a shared table shown where its list is not sorted.
   */
  sort?: Pick<ListSort<K>, 'sort' | 'order' | 'toggle'> | undefined;
  /** The column label (title case). */
  children: React.ReactNode;
}

const ARIA_SORT: Record<ListSortOrder, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

const NEXT_STEP = {
  none: 'common.sortAscending',
  asc: 'common.sortDescending',
  desc: 'common.sortDefault',
} as const satisfies Record<ListSortOrder | 'none', string>;

/**
 * A table column header that sorts the list on the server (`frontend/ui.md`, "Sortable
 * columns"): a click sorts ascending, the next descending, the next back to the default
 * order. The arrow shows the direction, `aria-sort` tells assistive technology, and the
 * button names the next step.
 */
export function SortableTableHead<K extends string>({
  sortKey,
  sort,
  children,
  className,
  ...props
}: SortableTableHeadProps<K>): React.JSX.Element {
  const { t } = useTranslation();
  if (sort == null) {
    return (
      <TableHead className={className} {...props}>
        {children}
      </TableHead>
    );
  }
  const direction = sort.sort === sortKey ? sort.order : null;
  let Icon = ArrowUpDown;
  if (direction === 'asc') Icon = ArrowUp;
  if (direction === 'desc') Icon = ArrowDown;

  return (
    <TableHead
      aria-sort={direction == null ? undefined : ARIA_SORT[direction]}
      className={className}
      {...props}
    >
      <button
        type="button"
        data-testid={`sort-${sortKey}`}
        className={cn(
          '-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          direction != null && 'text-foreground',
        )}
        onClick={() => {
          sort.toggle(sortKey);
        }}
      >
        {children}
        <Icon
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0', direction == null && 'opacity-50')}
        />
        <span className="sr-only">, {t(NEXT_STEP[direction ?? 'none'])}</span>
      </button>
    </TableHead>
  );
}
