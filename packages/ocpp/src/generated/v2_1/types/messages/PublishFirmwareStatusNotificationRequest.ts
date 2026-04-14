import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { PublishFirmwareStatusEnum } from '../../enums/PublishFirmwareStatusEnum.js';

export interface PublishFirmwareStatusNotificationRequest {
  status: PublishFirmwareStatusEnum;
  location?: string[];
  requestId?: number;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
