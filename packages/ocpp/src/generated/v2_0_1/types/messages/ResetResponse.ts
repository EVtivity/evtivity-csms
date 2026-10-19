import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ResetStatusEnum } from '../../enums/ResetStatusEnum.js';

export interface ResetResponse {
  customData?: CustomDataType;
  status: ResetStatusEnum;
  statusInfo?: StatusInfoType;
}
