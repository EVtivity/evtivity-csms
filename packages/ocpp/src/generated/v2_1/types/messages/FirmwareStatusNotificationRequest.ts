import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { FirmwareStatusEnum } from '../../enums/FirmwareStatusEnum.js';

export interface FirmwareStatusNotificationRequest {
  status: FirmwareStatusEnum;
  requestId?: number;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
