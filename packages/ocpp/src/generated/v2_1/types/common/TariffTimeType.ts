import type { CustomDataType } from './CustomDataType.js';
import type { TariffTimePriceType } from './TariffTimePriceType.js';
import type { TaxRateType } from './TaxRateType.js';

export interface TariffTimeType {
  prices: TariffTimePriceType[];
  taxRates?: TaxRateType[];
  customData?: CustomDataType;
}
