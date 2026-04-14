import type { CustomDataType } from './CustomDataType.js';

import type { DayOfWeekEnum } from '../../enums/DayOfWeekEnum.js';
import type { EvseKindEnum } from '../../enums/EvseKindEnum.js';

export interface TariffConditionsType {
  startTimeOfDay?: string;
  endTimeOfDay?: string;
  dayOfWeek?: DayOfWeekEnum[];
  validFromDate?: string;
  validToDate?: string;
  evseKind?: EvseKindEnum;
  minEnergy?: number;
  maxEnergy?: number;
  minCurrent?: number;
  maxCurrent?: number;
  minPower?: number;
  maxPower?: number;
  minTime?: number;
  maxTime?: number;
  minChargingTime?: number;
  maxChargingTime?: number;
  minIdleTime?: number;
  maxIdleTime?: number;
  customData?: CustomDataType;
}
