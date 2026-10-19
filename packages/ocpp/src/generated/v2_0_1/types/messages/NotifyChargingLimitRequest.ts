import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingLimitSourceEnum } from '../../enums/ChargingLimitSourceEnum.js';

export interface ChargingLimitType {
  customData?: CustomDataType;
  chargingLimitSource: ChargingLimitSourceEnum;
  isGridCritical?: boolean;
}

export interface NotifyChargingLimitRequest {
  customData?: CustomDataType;
  chargingSchedule?: ChargingScheduleType[];
  evseId?: number;
  chargingLimit: ChargingLimitType;
}
