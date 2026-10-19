import type { CustomDataType } from '../common/CustomDataType.js';

import type { UploadLogStatusEnum } from '../../enums/UploadLogStatusEnum.js';

export interface LogStatusNotificationRequest {
  customData?: CustomDataType;
  status: UploadLogStatusEnum;
  requestId?: number;
}
