import type { CustomDataType } from './CustomDataType.js';

export interface ChargingSchedulePeriodType {
  customData?: CustomDataType;
  startPeriod: number;
  limit: number;
  numberPhases?: number;
  phaseToUse?: number;
}
