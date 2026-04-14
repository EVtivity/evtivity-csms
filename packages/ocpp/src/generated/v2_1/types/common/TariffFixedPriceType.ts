import type { CustomDataType } from './CustomDataType.js';
import type { TariffConditionsFixedType } from './TariffConditionsFixedType.js';

export interface TariffFixedPriceType {
  conditions?: TariffConditionsFixedType;
  priceFixed: number;
  customData?: CustomDataType;
}
