import type { CustomDataType } from './CustomDataType.js';
import type { TaxRateType } from './TaxRateType.js';

export interface PriceType {
  exclTax?: number;
  inclTax?: number;
  taxRates?: TaxRateType[];
  customData?: CustomDataType;
}
