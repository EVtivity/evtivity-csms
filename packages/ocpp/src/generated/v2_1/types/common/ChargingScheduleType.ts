import type { AbsolutePriceScheduleType } from './AbsolutePriceScheduleType.js';
import type { ChargingSchedulePeriodType } from './ChargingSchedulePeriodType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { LimitAtSoCType } from './LimitAtSoCType.js';
import type { PriceLevelScheduleType } from './PriceLevelScheduleType.js';
import type { SalesTariffType } from './SalesTariffType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';

export interface ChargingScheduleType {
  id: number;
  limitAtSoC?: LimitAtSoCType;
  startSchedule?: string;
  duration?: number;
  chargingRateUnit: ChargingRateUnitEnum;
  minChargingRate?: number;
  powerTolerance?: number;
  signatureId?: number;
  digestValue?: string;
  useLocalTime?: boolean;
  chargingSchedulePeriod: ChargingSchedulePeriodType[];
  randomizedDelay?: number;
  salesTariff?: SalesTariffType;
  absolutePriceSchedule?: AbsolutePriceScheduleType;
  priceLevelSchedule?: PriceLevelScheduleType;
  customData?: CustomDataType;
}
