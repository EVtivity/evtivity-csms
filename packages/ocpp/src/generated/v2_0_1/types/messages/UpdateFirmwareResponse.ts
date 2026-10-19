import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { UpdateFirmwareStatusEnum } from '../../enums/UpdateFirmwareStatusEnum.js';

export interface UpdateFirmwareResponse {
  customData?: CustomDataType;
  status: UpdateFirmwareStatusEnum;
  statusInfo?: StatusInfoType;
}
