import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { LogStatusEnum } from '../../enums/LogStatusEnum.js';

export interface GetLogResponse {
  customData?: CustomDataType;
  status: LogStatusEnum;
  statusInfo?: StatusInfoType;
  filename?: string;
}
