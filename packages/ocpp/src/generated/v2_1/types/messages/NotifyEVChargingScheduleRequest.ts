import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyEVChargingScheduleRequest {
  timeBase: string;
  chargingSchedule: ChargingScheduleType;
  evseId: number;
  selectedChargingScheduleId?: number;
  powerToleranceAcceptance?: boolean;
  customData?: CustomDataType;
}
