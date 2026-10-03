// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatConvertedPrice } from '@/lib/formatting';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { useCompanyTaxBasis } from '@/hooks/use-company-tax-basis';

// Tariff prices are entered in the company tax basis (company.taxBasis).
// Below a price field while editing, shows the price on the other side of
// tax: the gross price for net prices, the net price for gross prices.
export function TaxPriceHint({
  price,
  taxRate,
}: {
  price: string;
  taxRate: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { currency } = useCompanyCurrency();
  const taxBasis = useCompanyTaxBasis();
  // Hidden until the company currency and tax basis have loaded.
  if (currency == null || taxBasis == null) return null;
  const converted = formatConvertedPrice(price, taxRate, taxBasis, currency);
  if (converted == null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t(taxBasis === 'gross' ? 'pricing.netPriceHint' : 'pricing.grossPriceHint', {
        price: converted,
      })}
    </p>
  );
}
