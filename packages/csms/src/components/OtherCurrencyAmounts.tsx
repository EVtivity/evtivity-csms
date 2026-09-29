// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { formatCents } from '@/lib/formatting';

/** Smaller lines under a money figure for the amounts in other currencies. */
export function OtherCurrencyAmounts<T extends { currency: string }>({
  entries,
  amount,
}: {
  entries: T[];
  amount: (entry: T) => number;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {entries.map((e) => (
        <div key={e.currency} className="whitespace-nowrap">
          {formatCents(amount(e), e.currency)}
        </div>
      ))}
    </div>
  );
}
