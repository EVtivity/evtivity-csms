import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { SendLocalListStatusEnum } from '../../enums/SendLocalListStatusEnum.js';

export interface SendLocalListResponse {
  customData?: CustomDataType;
  status: SendLocalListStatusEnum;
  statusInfo?: StatusInfoType;
}
