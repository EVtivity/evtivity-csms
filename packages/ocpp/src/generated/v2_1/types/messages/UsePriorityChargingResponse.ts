import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { PriorityChargingStatusEnum } from '../../enums/PriorityChargingStatusEnum.js';

export interface UsePriorityChargingResponse {
  status: PriorityChargingStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
