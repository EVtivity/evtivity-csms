import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ChangeAvailabilityStatusEnum } from '../../enums/ChangeAvailabilityStatusEnum.js';

export interface ChangeAvailabilityResponse {
  status: ChangeAvailabilityStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
