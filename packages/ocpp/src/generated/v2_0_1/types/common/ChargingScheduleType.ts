import type { ChargingSchedulePeriodType } from './ChargingSchedulePeriodType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { SalesTariffType } from './SalesTariffType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';

export interface ChargingScheduleType {
  customData?: CustomDataType;
  id: number;
  startSchedule?: string;
  duration?: number;
  chargingRateUnit: ChargingRateUnitEnum;
  chargingSchedulePeriod: ChargingSchedulePeriodType[];
  minChargingRate?: number;
  salesTariff?: SalesTariffType;
}
