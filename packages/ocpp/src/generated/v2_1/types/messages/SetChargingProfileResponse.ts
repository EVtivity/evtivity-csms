import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ChargingProfileStatusEnum } from '../../enums/ChargingProfileStatusEnum.js';

export interface SetChargingProfileResponse {
  status: ChargingProfileStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
