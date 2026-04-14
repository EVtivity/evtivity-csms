import type { ChargingSchedulePeriodType } from './ChargingSchedulePeriodType.js';

export interface ChargingScheduleType {
  duration?: number;
  startSchedule?: string;
  chargingRateUnit: string;
  chargingSchedulePeriod: ChargingSchedulePeriodType[];
  minChargingRate?: number;
}
