import type { CustomDataType } from '../common/CustomDataType.js';

import type { FirmwareStatusEnum } from '../../enums/FirmwareStatusEnum.js';

export interface FirmwareStatusNotificationRequest {
  customData?: CustomDataType;
  status: FirmwareStatusEnum;
  requestId?: number;
}
