import type { CustomDataType } from './CustomDataType.js';
import type { TariffConditionsType } from './TariffConditionsType.js';

export interface TariffTimePriceType {
  priceMinute: number;
  conditions?: TariffConditionsType;
  customData?: CustomDataType;
}
