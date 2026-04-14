import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ResetStatusEnum } from '../../enums/ResetStatusEnum.js';

export interface ResetResponse {
  status: ResetStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
