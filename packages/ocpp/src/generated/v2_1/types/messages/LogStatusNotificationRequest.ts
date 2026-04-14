import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { UploadLogStatusEnum } from '../../enums/UploadLogStatusEnum.js';

export interface LogStatusNotificationRequest {
  status: UploadLogStatusEnum;
  requestId?: number;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
