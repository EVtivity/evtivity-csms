// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatGrossPrice } from '@/lib/formatting';

// Tariff prices are net; the cost calculation adds the tariff tax rate on top.
// Shows the resulting gross price below a price field while editing.
export function GrossPriceHint({
  price,
  taxRate,
}: {
  price: string;
  taxRate: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const gross = formatGrossPrice(price, taxRate);
  if (gross == null) return null;
  return (
    <p className="text-xs text-muted-foreground">{t('pricing.grossPriceHint', { price: gross })}</p>
  );
}
