import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { NotifyEVChargingNeedsStatusEnum } from '../../enums/NotifyEVChargingNeedsStatusEnum.js';

export interface NotifyEVChargingNeedsResponse {
  status: NotifyEVChargingNeedsStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
