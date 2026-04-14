import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GetChargingProfileStatusEnum } from '../../enums/GetChargingProfileStatusEnum.js';

export interface GetChargingProfilesResponse {
  status: GetChargingProfileStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
