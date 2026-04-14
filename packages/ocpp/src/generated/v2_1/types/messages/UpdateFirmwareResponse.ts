import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { UpdateFirmwareStatusEnum } from '../../enums/UpdateFirmwareStatusEnum.js';

export interface UpdateFirmwareResponse {
  status: UpdateFirmwareStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
