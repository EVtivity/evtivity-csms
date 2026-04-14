import type { CustomDataType } from './CustomDataType.js';
import type { TariffEnergyPriceType } from './TariffEnergyPriceType.js';
import type { TaxRateType } from './TaxRateType.js';

export interface TariffEnergyType {
  prices: TariffEnergyPriceType[];
  taxRates?: TaxRateType[];
  customData?: CustomDataType;
}
