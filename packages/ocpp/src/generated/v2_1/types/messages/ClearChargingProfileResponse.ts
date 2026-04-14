import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ClearChargingProfileStatusEnum } from '../../enums/ClearChargingProfileStatusEnum.js';

export interface ClearChargingProfileResponse {
  status: ClearChargingProfileStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
