import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { SetNetworkProfileStatusEnum } from '../../enums/SetNetworkProfileStatusEnum.js';

export interface SetNetworkProfileResponse {
  customData?: CustomDataType;
  status: SetNetworkProfileStatusEnum;
  statusInfo?: StatusInfoType;
}
