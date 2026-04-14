import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ReserveNowStatusEnum } from '../../enums/ReserveNowStatusEnum.js';

export interface ReserveNowResponse {
  status: ReserveNowStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
