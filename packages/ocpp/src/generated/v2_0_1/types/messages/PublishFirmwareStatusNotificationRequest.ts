import type { CustomDataType } from '../common/CustomDataType.js';

import type { PublishFirmwareStatusEnum } from '../../enums/PublishFirmwareStatusEnum.js';

export interface PublishFirmwareStatusNotificationRequest {
  customData?: CustomDataType;
  status: PublishFirmwareStatusEnum;
  location?: string[];
  requestId?: number;
}
