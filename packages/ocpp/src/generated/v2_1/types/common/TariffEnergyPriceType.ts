import type { CustomDataType } from './CustomDataType.js';
import type { TariffConditionsType } from './TariffConditionsType.js';

export interface TariffEnergyPriceType {
  priceKwh: number;
  conditions?: TariffConditionsType;
  customData?: CustomDataType;
}
