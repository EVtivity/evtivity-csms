import type { ChargingScheduleUpdateType } from '../common/ChargingScheduleUpdateType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface UpdateDynamicScheduleRequest {
  chargingProfileId: number;
  scheduleUpdate: ChargingScheduleUpdateType;
  customData?: CustomDataType;
}
