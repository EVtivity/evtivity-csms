import type { GetCompositeScheduleChargingRateUnitEnum } from '../../enums/GetCompositeScheduleChargingRateUnitEnum.js';

export interface GetCompositeSchedule {
  connectorId: number;
  duration: number;
  chargingRateUnit?: GetCompositeScheduleChargingRateUnitEnum;
}
