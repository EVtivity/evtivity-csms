import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyEVChargingScheduleRequest {
  customData?: CustomDataType;
  timeBase: string;
  chargingSchedule: ChargingScheduleType;
  evseId: number;
}
