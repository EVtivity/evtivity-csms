import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { RequestStartStopStatusEnum } from '../../enums/RequestStartStopStatusEnum.js';

export interface RequestStopTransactionResponse {
  customData?: CustomDataType;
  status: RequestStartStopStatusEnum;
  statusInfo?: StatusInfoType;
}
