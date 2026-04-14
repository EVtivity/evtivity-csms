import type { CustomDataType } from './CustomDataType.js';
import type { TariffFixedPriceType } from './TariffFixedPriceType.js';
import type { TaxRateType } from './TaxRateType.js';

export interface TariffFixedType {
  prices: TariffFixedPriceType[];
  taxRates?: TaxRateType[];
  customData?: CustomDataType;
}
