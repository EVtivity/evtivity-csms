import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface ChargingLimitType {
  chargingLimitSource: string;
  isLocalGeneration?: boolean;
  isGridCritical?: boolean;
  customData?: CustomDataType;
}

export interface NotifyChargingLimitRequest {
  chargingSchedule?: ChargingScheduleType[];
  evseId?: number;
  chargingLimit: ChargingLimitType;
  customData?: CustomDataType;
}
