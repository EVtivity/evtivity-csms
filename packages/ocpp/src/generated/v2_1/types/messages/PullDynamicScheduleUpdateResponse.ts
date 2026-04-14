import type { ChargingScheduleUpdateType } from '../common/ChargingScheduleUpdateType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ChargingProfileStatusEnum } from '../../enums/ChargingProfileStatusEnum.js';

export interface PullDynamicScheduleUpdateResponse {
  scheduleUpdate?: ChargingScheduleUpdateType;
  status: ChargingProfileStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
