import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GetDisplayMessagesStatusEnum } from '../../enums/GetDisplayMessagesStatusEnum.js';

export interface GetDisplayMessagesResponse {
  status: GetDisplayMessagesStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
