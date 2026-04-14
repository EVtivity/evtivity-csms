import type { CustomDataType } from './CustomDataType.js';
import type { MessageContentType } from './MessageContentType.js';
import type { PriceType } from './PriceType.js';
import type { TariffEnergyType } from './TariffEnergyType.js';
import type { TariffFixedType } from './TariffFixedType.js';
import type { TariffTimeType } from './TariffTimeType.js';

export interface TariffType {
  tariffId: string;
  description?: MessageContentType[];
  currency: string;
  energy?: TariffEnergyType;
  validFrom?: string;
  chargingTime?: TariffTimeType;
  idleTime?: TariffTimeType;
  fixedFee?: TariffFixedType;
  reservationTime?: TariffTimeType;
  reservationFixed?: TariffFixedType;
  minCost?: PriceType;
  maxCost?: PriceType;
  customData?: CustomDataType;
}
